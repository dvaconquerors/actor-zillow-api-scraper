## Setup

1) Clone GitHub repo

```shell
git clone https://github.com/dvaconquerors/actor-zillow-api-scraper.git
```

2) Install Node Version Manager (NVM)

```shell
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.37.2/install.sh | bash
```

3) Install Node.js

```shell
nvm use
```

4) Install Apify CLI

```shell
npm -g install apify-cli
```

5) Log into Apify CLI

```shell
apify login
```

6) Initialize Apify

```shell
apify init
```

7) Install project packages

```shell
npm install
```

8) Edit `INPUT.json`

- Open `apify_storage/key_value_stores/default/INPUT.json`

- Update with your dataset:
```json
{
  "dataset": 0,
  "accessKeyId": "your-access-key-id",
  "secretAccessKey": "your-secret-access-key",
  "region": "us-east-1",
  "bucket": "bucket-name"
}
```

9) Run Apify Actor

```shell
apify run
```

### For the Windies
(Note: [There seems to be a compatibility issue with WSL2/Puppeteer](https://github.com/puppeteer/puppeteer/issues/5429), but it seems to work on Windows.)

1) Clone GitHub repo

```shell
git clone https://github.com/dvaconquerors/actor-zillow-api-scraper.git
```

2) Uninstall Node/npm (and make sure to also clear out `C:/Users/<username>/AppData/Roaming/npm`)

3) Install [NVM-Windows](https://github.com/coreybutler/nvm-windows)

4) Install and use Node.js/npm. (Note version is specified in `.nvmrc` file, and it's important to use the 32-bit version because the `better-sqlite3` npm package relies on this.)

```shell
nvm install 12.16.0 32
```

```shell
nvm use 12.16.0 32
```

5) Install Apify CLI

```shell
npm -g install apify-cli
```

6) Log into Apify CLI

```shell
apify login
```

7) Initialize Apify

```shell
apify init
```

8) Install project packages

```shell
npm install
```

9) Edit `INPUT.json`

- Open `apify_storage/key_value_stores/default/INPUT.json`

- Update with your dataset:
```json
{
  "dataset": 0,
  "accessKeyId": "your-access-key-id",
  "secretAccessKey": "your-secret-access-key",
  "region": "us-east-1",
  "bucket": "bucket-name"
}
```

10) Run Apify Actor

```shell
apify run
```
