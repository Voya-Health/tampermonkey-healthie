const puppeteer = require('puppeteer');
const fs = require('fs').promises;

(async () => {
  const pathToTampermonkey = '/Users/macosventura/Library/Application Support/Google/Chrome/Default/Extensions/dhdgffkkebhmkfjojejmpbldmpobfkfo/5.0.0_0'; // Replace with the correct version
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: [
      `--disable-extensions-except=${pathToTampermonkey}`,
      `--load-extension=${pathToTampermonkey}`,
    ],
  });
  const page = await browser.newPage();

  // Login
  await page.goto('https://securestaging.gethealthie.com/users/sign_in');
  await page.waitForTimeout(25000);

  await page.type('#email', 'alejandro.oyuela@vorihealth.com'); // Replace with your credentials
  await page.type('#password', 'bVb8hN4mdV%P8mK!'); // Replace with your credentials
  await page.click('#submit-field__button'); // Replace with the correct selector
  await page.waitForNavigation();

  // Navigate to the specific page
  await page.goto('https://securestaging.gethealthie.com/clients/active');

  // Mocking Tampermonkey objects
  await page.evaluate(() => {
    window.GM_getValue = () => undefined;
    window.GM_setValue = () => { };
    window.unsafeWindow = window;
  });

  const tampermonkeyScript = await fs.readFile('../careplanstaging.js', 'utf8');
  await page.evaluate(tampermonkeyScript);

  // Give some time for the script to execute
  await page.waitForTimeout(25000);

  // Simulate a click on the 'Add Client' button
  await page.click('.add-client-container button'); // Use the correct selector

  let isCloseButtonPresent = false;
  try {
    await page.waitForTimeout(5000);
    await page.waitForSelector('.close-button', { timeout: 5000 });
    isCloseButtonPresent = true;
  } catch (error) {
    console.error("The close button was not found.");
  }

  console.assert(isCloseButtonPresent, "The close button did not appear after clicking the 'Add Client' button.");

  // If the close button is present, click it
  if (isCloseButtonPresent) {
    await page.click('.close-button');
    console.log("Close button clicked, the 'Add Client' button was cloned correctly.");
    await page.waitForTimeout(5000);

  }

  await page.goto('https://securestaging.gethealthie.com/users/703049/all_plans');
  await page.waitForTimeout(25000);
  const careplanIframeSelector = '#MishaFrame';
  let isCareplanIFramePresent = false;
  try {
    await page.waitForSelector(careplanIframeSelector, { timeout: 5000 });
    isCareplanIFramePresent = true;
    console.log("Care Plans are working correctly.");
  } catch (error) {
    console.error("The specified Iframe was not found.");
  }
  console.assert(isCareplanIFramePresent, "The misha Iframe was loaded, Care Plans are working correctly");

  await page.goto('https://securestaging.gethealthie.com/users/703049/Overview');
  await page.waitForTimeout(25000);
  const mishaFrameSelector = '#MishaFrame';
  let isMishaFramePresent = false;
  try {
    await page.waitForSelector(mishaFrameSelector, { timeout: 5000 });
    isMishaFramePresent = true;
    console.log("Appointments are working correctly.");
  } catch (error) {
    console.error("The specified Appointment was not found.");
  }
  console.assert(isMishaFramePresent, "The misha Iframe was loaded, Appointments are working correctly");

  await page.waitForSelector('button[data-testid="primaryButton"]');


  // Click the specific button with text "Book Appointment"
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button[data-testid="primaryButton"]'));
    const targetButton = buttons.find(button => button.textContent === "Book Appointment");
    if (targetButton) {
      targetButton.click();
    }
  });


  // Check for the close button after clicking "Book Appointment"
  let isCloseCalendarButtonPresent = false;
  try {
    await page.waitForTimeout(5000); // Wait for potential modal/dialog to open
    await page.waitForSelector('.close-button', { timeout: 5000 });
    isCloseCalendarButtonPresent = true;
  } catch (error) {
    console.error("The close button was not found.");
  }


  console.assert(isCloseCalendarButtonPresent, "The close button did not appear after clicking the 'Book Appointment' button.");


  // If the close button is present, click it
  if (isCloseCalendarButtonPresent) {
    await page.click('.close-button');
    console.log("Close button clicked, the calendar Iframe is working correctly.");
    await page.waitForTimeout(5000);
  }


  await page.waitForTimeout(5000);
  await browser.close();
})();

