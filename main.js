const Apify = require('apify');
const S3 = require('aws-sdk/clients/s3');
const pLimit = require('p-limit');

const S3_BATCH_SIZE = 25;
const limit = pLimit(S3_BATCH_SIZE);

// Intercept home data API request and extract it's QueryID
const interceptQueryId = page => new Promise(async (resolve, reject) => {
  let resolved = false;
  await page.setRequestInterception(true);

  page.on('request', r => {
    const url = r.url();
    if (url.includes('https://www.zillow.com/graphql')) {
      const payload = r.postData();
      if (payload) {
        const data = JSON.parse(payload);
        if (data.operationName === 'ForSaleDoubleScrollFullRenderQuery') {
          resolved = true;
          resolve(data.queryId);
        } else {
          console.log(data.operationName);
        }
      }
    }
    r.continue();
  });

  const url = 'https://www.zillow.com/los-angeles-ca/';
  try {
    await page.goto(url);
    await page.waitForSelector('a.list-card-link');
    await page.click('a.list-card-link');
  } catch (e) {
    reject(e);
  }
  setTimeout(() => {
    if (!resolved) {
      reject();
    }
  }, 50000);
});

// Try intercepting QueryID until it's received
const getSampleQueryId = async () => {
  const browser = await Apify.launchPuppeteer({
    useChrome: true,
    stealth: true,
    launchOptions: {
      headless: false,
    },
  });
  for (let i = 0; i < 100; i++) {
    const page = await browser.newPage();
    try {
      const result = await interceptQueryId(page);
      await page.close();
      await browser.close();
      return result;
    } catch (e) {
      console.log('Settings extraction in progress...');
      await Apify.setValue('queryid-error.html', await page.content(), {contentType: 'text/html'});
      await page.close();
    }
  }
};

async function extractHomeData(page, zid, qid) {
  try {
    return await page.evaluate(async (zpid, queryId) => {
      const operationName = 'ForSaleDoubleScrollFullRenderQuery';
      const query = {
        operationName,
        variables: {zpid, contactFormRenderParameter: {zpid, platform: 'desktop', isDoubleScroll: true}},
        queryId,
      };
      const searchParams = new URLSearchParams({zpid, queryId, operationName});
      const resp = await fetch(`https://www.zillow.com/graphql/?${searchParams.toString()}`, {
        method: 'POST',
        body: JSON.stringify(query),
        headers: {
          'accept': '*/*',
          'accept-encoding': 'gzip, deflate, br',
          'accept-language': 'cs,en-US;q=0.9,en;q=0.8,de;q=0.7,es;q=0.6',
          'content-length': 276,
          'content-type': 'text/plain',
          'origin': 'https://www.zillow.com',
          'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Ubuntu Chromium/74.0.3729.169 Chrome/74.0.3729.169 Safari/537.36',
        },
      });
      const payload = await resp.json();
      return payload.data.property;
    }, zid, qid);
  } catch (e) {
    console.log(e);
    throw `Data extraction failed - zpid: ${zpid}`;
  }
}

async function checkForCaptcha(page) {
  if (await page.$('.captcha-container')) {
    await new Promise(resolve => setTimeout(resolve, 60_000));
    throw 'Captcha found, retrying...';
  }
}

// Extract initial queryState from page
async function getQueryState(page) {
  try {
    return await page.evaluate(() => {
      const scriptText = document.querySelector('script[data-zrr-shared-data-key="mobileSearchPageStore"]').textContent;
      const jsonText = scriptText.slice(4, scriptText.length - 3);
      return JSON.parse(jsonText).queryState;
    });
  } catch (e) {
    console.log(e);
    throw 'Unable to get queryState, retrying...';
  }
}

let request = 0;

async function getSearchState(page, qs) {
  try {
    request += 1;
    return await page.evaluate(async (queryState, requestId) => {
      queryState.filterState = {'isRecentlySold': {'value': true}};
      const qsParam = encodeURIComponent(JSON.stringify(queryState));
      const wantsParam = encodeURIComponent(JSON.stringify({cat1: ['listResults', 'mapResults']}));
      const url = `https://www.zillow.com/search/GetSearchPageState.htm?searchQueryState=${qsParam}&wants=${wantsParam}&requestId=${requestId}`;
      const resp = await fetch(url);

      const text = await resp.text();
      if (text.includes('captcha')) {
        await new Promise(resolve => setTimeout(resolve, 60_000));
        throw 'Captcha found, retrying...';
      }

      return JSON.parse(text);
    }, qs, request);
  } catch (e) {
    console.log(e);
    throw 'Unable to get searchState, retrying...';
  }
}

async function getMapResults(page, qs) {
  let searchState;
  try {
    searchState = await getSearchState(page, qs);
  } catch (e) {
    console.log(e);
    throw e;
  }

  if (searchState.cat1.searchResults.mapResults) {
    return searchState.cat1.searchResults.mapResults.filter(result => result.zpid);
  } else {
    throw `No map results at ${request.url}`;
  }
}

Apify.main(async () => {
  // Initialize state of the actor
  const state = await Apify.getValue('STATE') || {
    extractedZpids: [],
  };
  Apify.events.on('migrating', () => Apify.setValue('STATE', state));

  // Initialize and check input
  const input = await Apify.getInput();
  if (typeof input.dataset !== 'number') {
    throw new Error('Must provide "dataset" in INPUT.json');
  }

  const dataset_input = require(`./input_files/INPUT${input.dataset}.json`);
  if (!(dataset_input.search && dataset_input.search.trim().length > 0) && !dataset_input.zipcodes) {
    throw new Error('Either "search" or "zipcodes" attribute has to be set!');
  }

  // Create dataset
  const datasetName = `dataset-${input.dataset}`;
  const dataset = await Apify.openDataset(datasetName);

  // Initialize minimum time
  const minTime = dataset_input.minDate ? (parseInt(dataset_input.minDate) || new Date(dataset_input.minDate).getTime()) : null;

  const saveResults = async (results) => {
    results = results.filter(result => !minTime || result.datePosted > minTime);
    await dataset.pushData(results);
    state.extractedZpids.push(results.map(result => result.zpid));
  };

  // Intercept sample QueryID
  console.log('Extracting initial settings...');
  const queryId = await getSampleQueryId();
  console.log('Initial settings extracted.');

  // Proxy connection is automatically established in the Crawler
  // const proxyConfiguration = await Apify.createProxyConfiguration();

  // Create RequestQueue
  const requestQueue = await Apify.openRequestQueue();

  const addRequest = async (url, userData) => {
    console.log(`Adding request for ${url}`);
    await requestQueue.addRequest({url, ...(userData ? {userData} : {})});
  };

  if (dataset_input.zipcodes) {
    const urls = dataset_input.zipcodes.map(zipcode => `https://www.zillow.com/homes/${zipcode}`);
    await Promise.all(urls.map(url => addRequest(url)));
  }

  // Create crawler
  const crawler = new Apify.PuppeteerCrawler({
    requestQueue,

    // proxyConfiguration,

    maxRequestRetries: 3,

    handlePageTimeoutSecs: 120,

    maxRequestsPerCrawl: 750,

    launchContext: {
      useChrome: true,
      stealth: true,
    },

    handlePageFunction: async ({page, request, crawler}) => {
      let mapResults;
      try {
        await checkForCaptcha(page);
        const qs = request.userData.queryState || await getQueryState(page);
        mapResults = await getMapResults(page, qs);
      } catch (e) {
        await crawler.browserPool.retireBrowserByPage(page);
        throw e;
      }

      const numResults = Math.min(mapResults.length, dataset_input.resultsPerSearch || 500);
      if (numResults) {
        console.log(`Found ${mapResults.length} homes for ${request.url}, extracting data from ${numResults} ...`);

        // Extract home data from mapResults
        try {
          const homes = mapResults.slice(0, numResults);
          const results = await Promise.all(homes.map(home => extractHomeData(page, home.zpid, queryId)));
          await saveResults(results);
          console.log(`Saved ${results.length} records for ${request.url} total: ${state.extractedZpids.length}`);

        } catch (e) {
          await crawler.browserPool.retireBrowserByPage(page);
          await addRequest(request.url, request.userData);
          throw e;
        }
      } else {
        console.log(`Found no homes for ${request.url}`);
      }

      if (dataset_input.maxItems && state.extractedZpids.length >= dataset_input.maxItems) {
        return process.exit(0);
      }
    },
    handleFailedRequestFunction: async ({request}) => {
      // This function is called when the crawling of a request failed too many times
      console.log('Request ' + request.url + ' failed too many times.');
    },
  });

  // Start crawling
  await crawler.run();

  // Process results
  if (input.accessKeyId && input.secretAccessKey && input.region && input.bucket) {
    const s3 = new S3({
      apiVersion: '2006-03-01',
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
      region: input.region,
      Bucket: input.bucket,
    });

    const datasetInfo = await dataset.getInfo();

    const uploadToS3 = async (index) => {
      try {
        const content = await dataset.getData({offset: index, limit: 1});
        const item = content.items[0];

        await s3.putObject({
          Bucket: input.bucket,
          Key: `raw-zillow-data/${datasetName}/${item.zipcode}-${item.zpid}.json`,
          Body: JSON.stringify(item),
          ContentType: 'application/json',
        }).promise();
        if (index && index % 100 === 0) {
          console.log(`Completed uploading ${index} of ${datasetInfo.itemCount}`);
        }
      } catch (e) {
        throw new Error(`Unable to upload to S3: ${e.message}`);
      }
    };

    if (typeof datasetInfo.itemCount === 'number') {
      console.log(`Uploading ${datasetInfo.itemCount} files to S3. This may take a while`);

      const array = Array.from(Array(datasetInfo.itemCount).keys());
      await Promise.all(array.map(index => limit(() => uploadToS3(index))));

      console.log(`Uploaded ${datasetInfo.itemCount} files to S3.`);
    }
  } else {
    console.log('Must provide "accessKeyId", "secretAccessKey", "region", and "bucket" to upload to S3.');
  }
});
