# tampermonkey-healthie

Healthie integration with Tampermonkey

## Prerequisites

- [Node.js](https://nodejs.org/) (version 20.0 or higher)

## Cloning the Repository

To clone the repository, run the following command in your terminal:

git clone https://github.com/Voya-Health/tampermonkey-healthie.git
cd tampermonkey-healthie

## Installation

After cloning the repository, install the dependencies by running:

npm install

## Develop

The main branch of the project to develop from is staging, after installation switch to the proper branch by running:

git checkout staging

## Building and running the project

This project uses Webpack for building. To build the Tampermonkey files after any changes has been made for production and staging, run:

npm run build

You can then copy the contents of the generated careplanstaging.js into a TM script file via the TM dashboard to test the script in staging Healthie

## Testing

This project uses Puppeteer for testing. To execute the test run:

node puppeteerTesting.js

make sure to give permissions to the chrome extensions with the correct path from your machine in the following line from the file:

const pathToTampermonkey = '/Users/macosventura/Library/Application Support/Google/Chrome/Default/Extensions/dhdgffkkebhmkfjojejmpbldmpobfkfo/5.0.0_0'; // Replace with the correct version and path

After the test starts and google chrome opens, go to tampermonkey dashboard, import the TM file from the utilities tab and install it in the browser for the healthie page to work correctly, to import use the follloling url:

https://raw.githubusercontent.com/Voya-Health/tampermonkey-healthie/staging/careplanstaging.js

After is installed, go to the healthie tab that Puppeteer opened already for it to run the automated test.
