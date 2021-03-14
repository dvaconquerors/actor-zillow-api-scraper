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
  "dataset": 0
}
```

9) Run Apify Actor

```shell
apify run
```
