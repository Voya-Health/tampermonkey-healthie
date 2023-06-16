// ==UserScript==
// @name         Healthie Care Plan Integration
// @namespace    http://tampermonkey.net/
// @version      0.25
// @description  Injecting care plan components into Healthie
// @author       Don, Tonye
// @match        https://*.gethealthie.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=vori.health
// @sandbox      JavaScript
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

/* globals contentful */

let previousUrl = "";
const healthieAPIKey = GM_getValue("healthieApiKey", "");
const isStagingEnv = location.href.includes("securestaging") ? true : false;

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
      //Function that will check when goal tab has loaded
      waitGoalTab();
    }

    if (location.href.includes("/settings/api_keys")) {
      //Function to handle api keys
      waitSettingsAPIpage();
      showInstructions();
    }

    isAPIconnected();
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
    // handle edge case: clicking on careplan tab multiple times
    let careplanTabBtn = document.querySelector('a[data-testid="careplans-tab-btn"]');
    careplanTabBtn.addEventListener("click", handleCarePlanTabClick);

    function handleCarePlanTabClick() {
      if (location.href.includes("all_plans")) {
        if (healthieAPIKey !== "") {
          let tabContent = document.getElementsByClassName("cp-tab-contents");
          tabContent && tabContent[0].remove();
        }
        waitCarePlan();
      }
    }

    unsafeWindow.console.log(`tampermonkey removing`);
    //Locate and remove existing care plan tab content
    document.getElementsByClassName("cp-tab-contents")[0].remove();
    const parent = document.getElementsByClassName("column is-12 is-12-mobile")[0];

    if (healthieAPIKey === "") {
      let iframeMsgExists = document.querySelector(".vori-iframe-message");
      if (!iframeMsgExists) {
        const iframeMsgDiv = document.createElement("div");
        iframeMsgDiv.classList.add("vori-iframe-message");
        iframeMsgDiv.style.display = "block";
        iframeMsgDiv.style.position = "relative";
        iframeMsgDiv.style.background = "rgb(227 229 50 / 21%)";
        iframeMsgDiv.style.margin = "1.8rem";
        iframeMsgDiv.style.textAlign = "center";
        iframeMsgDiv.style.padding = "7rem 7vw";

        const iframeMsgLink = document.createElement("a");
        iframeMsgLink.textContent =
          "You cannot view Care Plan's until you connect your Healthie Account to Vori Health. Set it up here!";
        iframeMsgLink.href = "/settings/api_keys";
        iframeMsgLink.style.color = "#333";
        iframeMsgLink.style.fontSize = "18px";
        iframeMsgLink.style.letterSpacing = "0.3px";
        iframeMsgLink.style.textDecoration = "none";

        function addHoverEffect() {
          iframeMsgLink.style.textDecoration = "underline";
        }

        function removeHoverEffect() {
          iframeMsgLink.style.textDecoration = "none";
        }

        iframeMsgDiv.appendChild(iframeMsgLink);

        if (healthieAPIKey === "") {
          iframeMsgLink.addEventListener("mouseover", addHoverEffect);
          iframeMsgLink.addEventListener("mouseout", removeHoverEffect);
        } else {
          iframeMsgLink.removeEventListener("mouseover", addHoverEffect);
          iframeMsgLink.removeEventListener("mouseout", removeHoverEffect);
        }

        parent && parent.appendChild(iframeMsgDiv);
      }
    } else {
      //Create Div
      var iFrameNode = document.createElement("div");
      //Check for Healthie environment
      let iFrameURL = isStagingEnv ? "dev.misha.vori.health" : "misha.vorihealth.com";

      //Define inner HTML for created div
      iFrameNode.innerHTML =
        '<iframe id="MishaFrame"' +
        'title="Misha iFrame"' +
        'style="height: 100vh; width: 100%"' +
        'src="https://' +
        iFrameURL +
        '/email%7C632b22aa626051ee6441e397/careplan"' +
        ">" +
        "</iframe>";
      iFrameNode.setAttribute("class", "cp-tab-contents");

      //set iframe as child of healthie care plan tab element
      parent.appendChild(iFrameNode);

      //remove styling of healthie tab element
      document.getElementsByClassName("column is-12 is-12-mobile")[0].style = "";

          const patientNumber = location.href.split("/")[location.href.split("/").length - 2];

      // let's get all user goals before they're modified
      const getGoalQuery = `query {
                          goals(user_id: "${patientNumber}") {
                            id
                            name
                          }
                        }
                        `;
      const getGoalPayload = JSON.stringify({ query: getGoalQuery });
      goalMutation(getGoalPayload).then((response) => {
        const allGoals = response.data.goals;

        //due to XSS constraints listen for post message from Misha when care plan is submitted to update Healthie
        //confirming publishing of care plan will trigger window.parent.postMessage within Misha
        window.onmessage = function (event) {
          //check event to see if is care plan message
          if (event.data.tmInput !== undefined) {
            const carePlan = event.data.tmInput;
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
              } else if (!element.isVisible) {
                // if !element.isVisible let's update any goal with a matching id, update the due date to yesterday's date in format Month, Day, Year e.g Jun 12, 2021
                const yesterday = new Date(new Date().setDate(new Date().getDate() - 1));

                unsafeWindow.console.log("tampermonkey all user goals inside event are ", allGoals);

                let goalId = "";
                // find goal with matching name and get id
                allGoals.forEach((element) => {
                  if (element.name === milestoneTitle) {
                    goalId = element.id;
                  }
                });

                if (goalId === "") {
                  unsafeWindow.console.log("tampermonkey goal id not found");
                  return;
                } else {
                  unsafeWindow.console.log("tampermonkey goal found: " + goalId);
                }
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
      });
    }
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
      newWrapper.style.marginRight = "28px";

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
      let mainContainer = document.querySelector(".main-settings__container");
      mainContainer.appendChild(newWrapper);

      // Append the new elements to the new wrapper
      newWrapper.appendChild(newHeader);
      newWrapper.appendChild(inputButtonWrapper);
      inputButtonWrapper.appendChild(newInput);
      inputButtonWrapper.appendChild(newButton);
    } else {
      newButton = existingWrapper.querySelector("button");
      newInput = existingWrapper.querySelector("input");
    }

    let storedApiKey = GM_getValue("healthieApiKey", ""); // Retrieve the stored API key using GM_getValue
    newInput.value = storedApiKey; // Set the initial value of the input

    // Add onclick handler to the "Link Api key" button
    newButton.onclick = function () {
      var apiKey = newInput.value.trim(); // Trim whitespace from the input value
      if (apiKey === "") {
        alert("Please enter a valid API key!");
      } else {
        GM_setValue("healthieApiKey", apiKey);
        alert("API key saved successfully!");
        window.setTimeout(null, 2000);
        window.location.reload();
      }
    };
  } else {
    //wait for content load
    unsafeWindow.console.log(`tampermonkey waiting for api keys section`);
    window.setTimeout(waitSettingsAPIpage, 200);
  }
}

function isAPIconnected() {
  //check to see if the header has loaded
  if (document.querySelector(".header")) {
    let voriHeaderExists = document.querySelector(".vori-api-message");
    if (!voriHeaderExists) {
      const header = document.querySelector(".header");
      const apiMsgDiv = document.createElement("div");
      apiMsgDiv.classList.add("vori-api-message");
      apiMsgDiv.style.display = "block";
      apiMsgDiv.style.position = "relative";
      apiMsgDiv.style.background = "#e3e532";
      apiMsgDiv.style.top = "60px";
      apiMsgDiv.style.minHeight = "42px";
      apiMsgDiv.style.textAlign = "center";
      apiMsgDiv.style.padding = "10px";

      const apiMsgLink = document.createElement("a");
      apiMsgLink.textContent = "You have not connected your Healthie Account to Vori Health. Set it up here!";
      apiMsgLink.href = "/settings/api_keys";
      apiMsgLink.style.color = "#333";
      apiMsgLink.style.fontSize = "15px";
      apiMsgLink.style.letterSpacing = "0.3px";
      apiMsgLink.style.textDecoration = "none";

      function addHoverEffect() {
        apiMsgLink.style.textDecoration = "underline";
      }

      function removeHoverEffect() {
        apiMsgLink.style.textDecoration = "none";
      }

      apiMsgDiv.appendChild(apiMsgLink);

      if (healthieAPIKey === "") {
        apiMsgDiv.style.display = "block";
        apiMsgLink.addEventListener("mouseover", addHoverEffect);
        apiMsgLink.addEventListener("mouseout", removeHoverEffect);
      } else {
        apiMsgDiv.style.display = "none";
        apiMsgLink.removeEventListener("mouseover", addHoverEffect);
        apiMsgLink.removeEventListener("mouseout", removeHoverEffect);
      }

      header.insertAdjacentElement("afterend", apiMsgDiv);
    }
  } else {
    //wait for content load
    unsafeWindow.console.log(`tampermonkey waiting for header`);
    window.setTimeout(isAPIconnected, 200);
  }
}

function showInstructions() {
  if (document.querySelector(".api-keys-wrapper") && document.querySelector(".api-keys-wrapper p")) {
    const apiKeyParagraph = document.querySelector(".api-keys-wrapper p");

    if (healthieAPIKey === "") {
      const instructions = document.createElement("p");
      instructions.innerHTML =
        "<b>Vori Health Instructions</b><br />" +
        '1. Click the button below that says <i>"Add API Key"</i><br />' +
        '2. Enter a memorable name in the <i>API Key Name</i> field then click on "Create API Key"<br />' +
        "3. The API Key should now be listed below. Copy the text under the <i>Key</i> column.<br />" +
        '4. Now under the "Connect to Vori Health" section, paste the key in the box that says <i>Enter your API Key here</i>, and then select the "Link Api key" button.<br />' +
        '5. You should see a message saying "API key saved successfully"<br />';
      instructions.classList.add("vori-instruction-message");
      instructions.style.display = "block";
      instructions.style.position = "relative";
      instructions.style.background = "rgb(227 229 50 / 35%)";
      instructions.style.color = "#16284a";
      instructions.style.minHeight = "42px";
      instructions.style.padding = "10px";
      instructions.style.marginTop = "14px";

      apiKeyParagraph.insertAdjacentElement("afterend", instructions);
    }
  } else {
    //wait for content load
    unsafeWindow.console.log(`tampermonkey waiting to show instructions`);
    window.setTimeout(showInstructions, 200);
  }
}

//config for observer
const config = { subtree: true, childList: true };
observer.observe(document, config);

const auth = `Basic ${healthieAPIKey}`;

function goalMutation(payload) {
  let response = null;
  let api_env = isStagingEnv ? "staging-api" : "api";
  response = fetch("https://" + api_env + ".gethealthie.com/graphql", {
    method: "POST",
    headers: {
      AuthorizationSource: "API",
      Authorization: auth,
      "content-type": "application/json",
    },
    body: payload,
  })
    .then((res) => res.json())
    .then((result) => {
      unsafeWindow.console.log("tampermonkey", result);
      return result;
    });

  return response;
}
