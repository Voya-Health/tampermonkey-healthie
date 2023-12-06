
import { debugLog } from '../utils/index';
import { createTimeout } from '../helpers/timeoutHelpers';
import { addHoverEffect, removeHoverEffect } from '../helpers/ui/index';
declare function GM_setValue(key: string, value: string | number | boolean | object | null | undefined): void;
declare function GM_getValue<T>(key: string, defaultValue: T): T;
declare var unsafeWindow: Window & typeof globalThis & { [key: string]: any };
const isStagingEnv: boolean = location.href.includes("securestaging") ? true : false;
let healthieAPIKey: string = GM_getValue(isStagingEnv ? "healthieStagingApiKey" : "healthieApiKey", "");
let auth: string = `Basic ${healthieAPIKey}`;


function healthieGQL(payload: string): Promise<any> {
    let api_env: string = isStagingEnv ? "staging-api" : "api";
    let response = fetch("https://" + api_env + ".gethealthie.com/graphql", {
      method: "POST",
      headers: {
        AuthorizationSource: "API",
        Authorization: auth,
        "content-type": "application/json",
      },
      body: payload,
    })
      .then((res: Response) => res.json())
      .then((result: any) => {
        debugLog("tampermonkey", result);
        return result;
      });
  
    return response;
  }

  function isAPIconnected(): void {
    // Check to see if the header has loaded
    let header: Element | null = document.querySelector(".header");
    if (header) {
      let voriHeaderExists: Element | null = document.querySelector(".vori-api-message");
      if (!voriHeaderExists) {
        const apiMsgDiv: HTMLDivElement = document.createElement("div");
        apiMsgDiv.classList.add("vori-api-message");
        apiMsgDiv.style.display = "block";
        apiMsgDiv.style.position = "relative";
        apiMsgDiv.style.background = "#e3e532";
        apiMsgDiv.style.top = "60px";
        apiMsgDiv.style.minHeight = "42px";
        apiMsgDiv.style.textAlign = "center";
        apiMsgDiv.style.padding = "10px";
  
        const apiMsgLink: HTMLAnchorElement = document.createElement("a");
        apiMsgLink.textContent = "You have not connected your Healthie Account to Vori Health. Set it up here!";
        apiMsgLink.href = "/settings/api_keys";
        apiMsgLink.style.color = "#333";
        apiMsgLink.style.fontSize = "15px";
        apiMsgLink.style.letterSpacing = "0.3px";
        apiMsgLink.style.textDecoration = "none";
  
        apiMsgLink.addEventListener("mouseover", () => addHoverEffect(apiMsgLink));
        apiMsgLink.addEventListener("mouseout", () => removeHoverEffect(apiMsgLink));
  
        apiMsgDiv.appendChild(apiMsgLink);
  
        if (healthieAPIKey === "") {
          apiMsgDiv.style.display = "block";
        } else {
          apiMsgDiv.style.display = "none";
        }
  
        header.insertAdjacentElement("afterend", apiMsgDiv);
      }
    } else {
      // Wait for content load
      debugLog(`tampermonkey waiting for header`);
      createTimeout(isAPIconnected, 200);
    }
  }
  function waitSettingsAPIpage(): void {
    //check to see if the care plan tab contents has loaded
    if (document.querySelector(".api_keys")) {
      debugLog(`tampermonkey found api keys section`);
      // Check if the api-keys-wrapper already exists
      let existingWrapper: HTMLElement | null = document.querySelector(".api-keys-wrapper.vori");
      let newButton: HTMLButtonElement;
      let newInput: HTMLInputElement;
  
      if (!existingWrapper) {
        // Create the new elements
        let newWrapper: HTMLDivElement = document.createElement("div");
        newWrapper.classList.add("api-keys-wrapper", "vori");
        newWrapper.style.marginTop = "2rem";
        newWrapper.style.paddingBottom = "2rem";
        newWrapper.style.borderBottom = "1px solid #e0e0e0";
        newWrapper.style.marginRight = "28px";
  
        let newHeader: HTMLDivElement = document.createElement("div");
        newHeader.classList.add("api-keys-header");
        newHeader.textContent = "Connect to Vori Health";
        newHeader.style.height = "44px";
        newHeader.style.color = "#16284a";
        newHeader.style.fontFamily = '"Avenir",Helvetica,"Arial",sans-serif';
        newHeader.style.fontWeight = "800";
        newHeader.style.fontSize = "28px";
        newHeader.style.lineHeight = "34px";
        newHeader.style.letterSpacing = "-.02em";
  
        let inputButtonWrapper: HTMLDivElement = document.createElement("div");
        inputButtonWrapper.classList.add("api-keys-input-button-wrapper");
        inputButtonWrapper.style.display = "flex";
        inputButtonWrapper.style.justifyContent = "space-between";
        inputButtonWrapper.style.width = "100%";
  
        newInput = document.createElement("input");
        newInput.setAttribute("type", "text");
        newInput.setAttribute("placeholder", "Enter your API key here");
        newInput.classList.add("api-key-input");
        newInput.style.height = "38px";
        newInput.style.width = "100%";
        newInput.style.maxWidth = "292px";
        newInput.style.padding = "0 14px";
        newInput.style.borderRadius = "4px";
        newInput.style.border = "1px solid #828282";
  
        newButton = document.createElement("button");
        newButton.setAttribute("type", "button");
        newButton.textContent = "Link API key";
        newButton.style.backgroundColor = "#4a90e2";
        newButton.style.color = "#fff";
        newButton.style.border = "1px solid #4a90e2";
        newButton.style.padding = "8px 10px";
        newButton.style.fontFamily = '"Avenir",Helvetica,"Arial",sans-serif';
        newButton.style.fontSize = "14px";
        newButton.style.lineHeight = "20px";
        newButton.style.width = "200px";
        newButton.style.borderRadius = "3px";
        newButton.style.cursor = "pointer";
  
        // Append the new elements to the existing container
        let mainContainer: HTMLElement | null = document.querySelector(".main-settings__container");
  
        if (mainContainer) {
          mainContainer.appendChild(newWrapper);
        } else {
          console.error("Main container not found");
          // Handle the error case appropriately
        }
  
        // Append the new elements to the new wrapper
        newWrapper.appendChild(newHeader);
        newWrapper.appendChild(inputButtonWrapper);
        inputButtonWrapper.appendChild(newInput);
        inputButtonWrapper.appendChild(newButton);
      } else {
        newButton = existingWrapper.querySelector("button") as HTMLButtonElement;
        newInput = existingWrapper.querySelector("input") as HTMLInputElement;
      }
  
      let storedApiKey: string = GM_getValue(isStagingEnv ? "healthieStagingApiKey" : "healthieApiKey", ""); // Retrieve the stored API key using GM_getValue
  
      if (storedApiKey === "") {
        newInput.value = storedApiKey; // Set the initial value of the input
      } else {
        newInput.value = "***************"; // show mask indicating that a valid key is stored
      }
  
      // Add onclick handler to the "Link Api key" button
      newButton.onclick = function () {
        let apiKey: string = newInput.value.trim(); // Trim whitespace from the input value
        if (apiKey === "") {
          alert("Please enter a valid API key!");
        } else {
          const patientNumber: string = location.href.split("/")[location.href.split("/").length - 2];
          healthieAPIKey = apiKey;
          auth = `Basic ${healthieAPIKey}`;
  
          // let's check that we can get goals successfully
          const getGoalQuery: string = `query {
            goals {
              id
              name
            }
          }
          `;
          const getGoalPayload: string = JSON.stringify({ query: getGoalQuery });
          healthieGQL(getGoalPayload).then((response: any) => {
            debugLog(`tampermonkey api key goals response: ${JSON.stringify(response)}`);
  
            if (response.errors) {
              alert("That is not a valid API key. Please verify the key and try again.");
            } else {
              GM_setValue(isStagingEnv ? "healthieStagingApiKey" : "healthieApiKey", apiKey);
              alert("API key saved successfully!");
              createTimeout(() => {
                window.location.reload();
              }, 2000);
              window.location.reload();
            }
          });
        }
      };
    } else {
      //wait for content load
      debugLog(`tampermonkey waiting for api keys section`);
      createTimeout(waitSettingsAPIpage, 200);
    }
  }
  export { healthieGQL, isAPIconnected, waitSettingsAPIpage };
