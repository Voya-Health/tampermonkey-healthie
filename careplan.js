// ==UserScript==
// @name         Healthie Care Plan Integration
// @namespace    http://tampermonkey.net/
// @version      0.21
// @description  Injecting care plan components into Healthie
// @author       Don
// @match        https://securestaging.gethealthie.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=vori.health
// @sandbox      JavaScript
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

/* globals contentful */

let previousUrl = "";
const healthieAPIKey = "";

//observe changes to the DOM, check for URL changes
const observer = new MutationObserver(function (mutations) {
  if (location.href !== previousUrl) {
    previousUrl = location.href;
    unsafeWindow.console.log(`tampermonkey URL changed to ${location.href}`);
    //Care plans URL
    if (location.href.includes("/all_plans")) {
      //Function that will check when care plan tab has loaded
      waitCarePlan();
    }

    if (location.href.includes("/users")) {
      //Function that will check when care plan tab has loaded
      waitGoalTab();
    }

    if (location.href.includes("/settings/api_keys")) {
      //Function to handle api keys
      waitSettingsAPIpage();
    }
  }
});

function waitGoalTab() {
  //check to see if the care plan tab contents has loaded
  if (document.querySelector('[data-testid="goals-tab-btn"]')) {
    unsafeWindow.console.log(`tampermonkey found goals tab`);
    document.querySelector('[data-testid="goals-tab-btn"]').parentElement.remove();
  } else {
    //wait for content load
    unsafeWindow.console.log(`tampermonkey waiting goals tab`);
    window.setTimeout(waitGoalTab, 200);
  }
}

function waitCarePlan() {
  //check to see if the care plan tab contents has loaded
  if (document.getElementsByClassName("cp-tab-contents")[0]) {
    unsafeWindow.console.log(`tampermonkey removing`);
    //Locate and remove existing care plan tab content
    document.getElementsByClassName("cp-tab-contents")[0].remove();

    //Create Div
    var iFrameNode = document.createElement("div");

    //Define inner HTML for created div
    iFrameNode.innerHTML =
      '<iframe id="MishaFrame"' +
      'title="Misha iFrame"' +
      'style="height: 100vh; width: 100%"' +
      'src="https://dev.misha.vori.health/email%7C632b22aa626051ee6441e397/careplan"' +
      ">" +
      "</iframe>";
    iFrameNode.setAttribute("class", "cp-tab-contents");

    //set iframe as child of healthie care plan tab element
    const parent = document.getElementsByClassName("column is-12 is-12-mobile")[0];
    parent.appendChild(iFrameNode);

    //remove styling of healthie tab element
    document.getElementsByClassName("column is-12 is-12-mobile")[0].style = "";

    //due to XSS constraints listen for post message from Misha when care plan is submitted to update Healthie
    //confirming publishing of care plan will trigger window.parent.postMessage within Misha
    window.onmessage = function (event) {
      //check event to see if is care plan message
      if (event.data.tmInput !== undefined) {
        const patientNumber = location.href.split("/")[location.href.split("/").length - 2];
        const carePlan = event.data.tmInput;
        unsafeWindow.console.log(
          `tampermonkey message posted ${patientNumber} care plan status ${JSON.stringify(carePlan)}`
        );
        const goal = carePlan.goal.title;
        unsafeWindow.console.log("tampermokey goal title ", goal);

        const milestones = carePlan.milestones;
        //create goal for each milestone
        milestones.forEach((element) => {
          unsafeWindow.console.log("tampermonkey milestone inserted", element);
          const milestoneTitle = element.title;
          if (element.isVisible) {
            const query = `mutation {
                          createGoal(input: {
                            name: "${milestoneTitle}",
                            user_id: "${patientNumber}",
                            repeat: "Once"
                          }) {
                            goal {
                              id
                            }
                            messages {
                              field
                              message
                            }
                          }
                        }
                        `;
            const payload = JSON.stringify({ query });
            goalMutation(payload);
          }
        });

        //create goal for what matters to me
        const query = `mutation {
                  createGoal(input: {
                    name: "${goal}",
                    user_id: "${patientNumber}",
                    repeat: "Once"
                  }) {
                    goal {
                      id
                    }
                    messages {
                      field
                      message
                    }
                  }
                }
                `;
        const payload = JSON.stringify({ query });
        goalMutation(payload);

        const tasks = carePlan.tasks.tasks;
        unsafeWindow.console.log("tampermonkey tasks are ", tasks);
        //create goal for each task
        tasks.forEach((element) => {
          unsafeWindow.console.log("tampermonkey task is ", element);
          if (element.contentfulId == "6nJFhYE6FJcnWLc3r1KHPR") {
            //motion guide task
            unsafeWindow.console.log("tampermonkey motion guide assigned");
            //create goal for each assigned exercise
            element.items[0].exercises.forEach((element) => {
              unsafeWindow.console.log("tampermonkey", element);
              const name = element.contentfulEntityId + " - " + element.side;
              const query = `mutation {
                          createGoal(input: {
                            name: "${name}",
                            user_id: "${patientNumber}",
                            repeat: "Daily"
                          }) {
                            goal {
                              id
                            }
                            messages {
                              field
                              message
                            }
                          }
                        }
                        `;
              const payload = JSON.stringify({ query });
              goalMutation(payload);
            });
          } else {
            if (element.isVisible) {
              //regular task
              unsafeWindow.console.log("tampermonkey regular task assigned");
              const query = `mutation {
                          createGoal(input: {
                            name: "${element.title}",
                            user_id: "${patientNumber}",
                            repeat: "Daily"
                          }) {
                            goal {
                              id
                            }
                            messages {
                              field
                              message
                            }
                          }
                        }
                        `;
              const payload = JSON.stringify({ query });
              goalMutation(payload);
            }
          }
        });
      }
    };
  } else {
    //wait for content load
    unsafeWindow.console.log(`tampermonkey waiting`);
    window.setTimeout(waitCarePlan, 200);
  }
}

function waitSettingsAPIpage() {
  //check to see if the care plan tab contents has loaded
  if (document.querySelector(".api_keys")) {
    unsafeWindow.console.log(`tampermonkey found api keys section`);
    // Check if the api-keys-wrapper already exists
    let existingWrapper = document.querySelector(".api-keys-wrapper.vori");
    let newButton;
    let newInput;

    if (!existingWrapper) {
      // Create the new elements
      let newWrapper = document.createElement("div");
      newWrapper.classList.add("api-keys-wrapper", "vori");
      newWrapper.style.marginTop = "2rem";
      newWrapper.style.paddingBottom = "2rem";
      newWrapper.style.borderBottom = "1px solid #e0e0e0";
      newWrapper.style.paddingRight = "28px";

      let newHeader = document.createElement("div");
      newHeader.classList.add("api-keys-header");
      newHeader.textContent = "Connect to Vori Health";
      newHeader.style.height = "44px";
      newHeader.style.color = "#16284a";
      newHeader.style.fontFamily = '"Avenir",Helvetica,"Arial",sans-serif';
      newHeader.style.fontWeight = "800";
      newHeader.style.fontSize = "28px";
      newHeader.style.lineHeight = "34px";
      newHeader.style.letterSpacing = "-.02em";

      let inputButtonWrapper = document.createElement("div");
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
      newButton.textContent = "Link Api key";
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


    // Add onclick handler to the "Link Api key" button
    newButton.onclick = function () {
      var apiKey = newInput.value.trim(); // Trim whitespace from the input value
      if (apiKey === "") {
        alert("Please enter a valid API key!");
      } else {
        GM_setValue("healthieApiKey", apiKey);
        alert("API key saved successfully!");
      }
    };
  } else {
    //wait for content load
    unsafeWindow.console.log(`tampermonkey waiting for api keys section`);
    window.setTimeout(waitSettingsAPIpage, 200);
  }
}

//config for observer
const config = { subtree: true, childList: true };
observer.observe(document, config);

const auth = `Basic ${healthieAPIKey}`;

function goalMutation(payload) {
  fetch("https://staging-api.gethealthie.com/graphql", {
    method: "POST",
    headers: {
      AuthorizationSource: "API",
      Authorization: auth,
      "content-type": "application/json",
    },
    body: payload,
  })
    .then((res) => res.json())
    .then((result) => unsafeWindow.console.log("tampermonkey", result));
}
