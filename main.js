const Apify = require('apify');

const ATTRIBUTES = [
  'zpid',
  'address',
  'bedrooms',
  'bathrooms',
  'price',
  'yearBuilt',
  'longitude',
  'latitude',
  'description',
  'livingArea',
  'currency',
  'homeType',
  'timeZone',
  'zestimate',
  'homeFacts',
  'taxAssessedValue',
  'taxAssessedYear',
  'lotSize',
  'datePosted',
];

const GRAPHQL_HEADERS = {
  'accept': '*/*',
  'accept-encoding': 'gzip, deflate, br',
  'accept-language': 'cs,en-US;q=0.9,en;q=0.8,de;q=0.7,es;q=0.6',
  'content-length': 276,
  'content-type': 'text/plain',
  'origin': 'https://www.zillow.com',
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Ubuntu Chromium/74.0.3729.169 Chrome/74.0.3729.169 Safari/537.36',
};

function pick(o, ...props) {
  return Object.assign({}, ...props.map(prop => ({[prop]: o[prop]})));
}

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
    const homeData = await page.evaluate(async (zpid, queryId) => {
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
        headers: GRAPHQL_HEADERS,
      });
      return await resp.json();
    }, zid, qid);

    return pick(homeData, ATTRIBUTES);
  } catch {
    throw `Data extraction failed - zpid: ${zpid}`;
  }
}

async function checkForCaptcha(page) {
  if (await page.$('.captcha-container')) {
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
    throw 'Unable to get queryState, retrying...';
  }
}

async function getSearchState(page, qs) {
  try {
    return await page.evaluate(async (queryState) => {
      const qsParam = encodeURIComponent(JSON.stringify(queryState));
      const url = `https://www.zillow.com/search/GetSearchPageState.htm?searchQueryState=${qsParam}`;
      console.log(`Getting Search State: ${url}`);
      const resp = await fetch(url);
      return await resp.json();
    }, qs);
  } catch (e) {
    throw 'Unable to get searchState, retrying...';
  }
}

async function getMapResults(page, request) {
  let searchState;
  try {
    const qs = request.userData.queryState || await getQueryState(page);
    console.log(`qs = ${JSON.stringify(qs)}`);
    searchState = await getSearchState(page, qs);
    console.log(`searchState = ${JSON.stringify(searchState)}`);
  } catch (e) {
    console.log(e);
    throw e;
  }

  if (searchState && searchState.searchResults.mapResults) {
    return searchState.searchResults.mapResults;
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
  if (!(input.search && input.search.trim().length > 0) && !input.zipcodes) {
    throw new Error('Either "search" or "zipcodes" attribute has to be set!');
  }

  // Initialize minimum time
  const minTime = input.minDate ? (parseInt(input.minDate) || new Date(input.minDate).getTime()) : null;

  const saveResult = async (result) => {
    if (!minTime || result.datePosted > minTime) {
      await Apify.pushData(result);
      state.extractedZpids.append(result.zpid);
    }
  };

  // Intercept sample QueryID
  console.log('Extracting initial settings...');
  const queryId = await getSampleQueryId();
  console.log(`Query ID = ${queryId}`);
  console.log('Initial settings extracted.');

  // Proxy connection is automatically established in the Crawler
  const proxyConfiguration = await Apify.createProxyConfiguration();

  // Create RequestQueue
  const requestQueue = await Apify.openRequestQueue();

  const addRequest = async (url, userData) => {
    console.log(`Adding request for ${url}`);
    await requestQueue.addRequest({url, ...(userData ? {userData} : {})});
  };

  if (input.search) {
    const term = input.search.trim().replace(/,(\s*)/g, '-').replace(/\s+/, '+').toLowerCase();
    const url = `https://www.zillow.com/homes/${term}`;
    await addRequest(url);
  }
  if (input.zipcodes) {
    const urls = input.zipcodes.map(zipcode => `https://www.zillow.com/homes/${zipcode}`);
    await Promise.all(urls.map(url => addRequest(url)));
  }

// Create crawler
  const crawler = new Apify.PuppeteerCrawler({
    requestQueue,

    proxyConfiguration,

    maxRequestRetries: 10,

    handlePageTimeoutSecs: 600,

    maxRequestsPerCrawl: 50,

    launchContext: {
      useChrome: true,
      stealth: true,
    },

    handlePageFunction: async ({page, request, crawler}) => {
      let mapResults;
      try {
        await checkForCaptcha(page);
        mapResults = await getMapResults(page, request);
      } catch (e) {
        await crawler.browserPool.retireBrowserByPage(page);
        throw e;
      }

      const numResults = Math.min(mapResults.length, input.resultsPerSearch || 500);
      console.log(`Found ${mapResults.length} homes for ${request.url}, extracting data from ${numResults} ...`);

      // Extract home data from mapResults
      const start = request.userData.start || 0;
      for (let i = start; i < numResults; i++) {
        const home = mapResults[i];
        if (!home.zpid || state.extractedZpids.includes(home.zpid)) continue;

        try {
          const result = await extractHomeData(page, home.zpid, queryId);
          await saveResult(result);
        } catch (e) {
          await crawler.browserPool.retireBrowserByPage(page);
          await addRequest(request.url, Object.assign(request.userData, {start: i}));
          throw e;
        }

        console.log(`Saved record for ${request.url}`);

        if (input.maxItems && state.extractedZpids.length >= input.maxItems) {
          return process.exit(0);
        }
      }
    },
    handleFailedRequestFunction: async ({request}) => {
      // This function is called when the crawling of a request failed too many times
      console.log('Request ' + request.url + ' failed too many times.');
    },
  });

  // Start crawling
  await crawler.run();
});
