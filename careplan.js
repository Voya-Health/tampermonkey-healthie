// ==UserScript==
// @name         Healthie Care Plan Integration
// @namespace    http://tampermonkey.net/
// @version      0.34
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
let healthieAPIKey = GM_getValue("healthieApiKey", "");
let auth = `Basic ${healthieAPIKey}`;
const isStagingEnv = location.href.includes("securestaging") ? true : false;
const routeURLs = {
  // TODO: update to standalone routes
  scheduling: "/app/schedule",
  careplan: "/app/schedule",
  goals: "/app/schedule",
  appointments: {
    create: "/app/schedule",
    view: "/app/schedule",
  },
};

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
      waitAppointmentsProfile();
    }

    if (location.href.includes("/settings/api_keys")) {
      //Function to handle api keys
      waitSettingsAPIpage();
      showInstructions();
    }

    if (
      location.href.includes("/appointments") ||
      location.href.includes("/organization") ||
      location.href.includes("/providers/")
    ) {
      waitAddAppointmentsBtn(); //Function to handle clicking the Add appointments button
      waitCalendar(); //Function to handle clicking on empty appointment slots
    }

    const baseURL = location.href.split(".").splice(1).join(".");
    unsafeWindow.console.log("tampermonkey splice is ", baseURL);
    if (baseURL == "gethealthie.com/overview" || baseURL == "gethealthie.com/") {
      waitAppointmentsHome();
    }

    if (location.href.includes("/conversations")) {
      waitAppointmentSidebar();
      waitInfo();
    }

    isAPIconnected();
  }
});

function initJQuery() {
  let $ = unsafeWindow.jQuery;
  if ($ && $ !== undefined && typeof $ === "function") {
    return $;
  } else {
    unsafeWindow.console.log(`tampermonkey waiting for jquery to load`);
    let script = document.createElement("script");
    script.src = "https://code.jquery.com/jquery-3.7.0.min.js";
    script.type = "text/javascript";
    script.onload = function () {
      unsafeWindow.console.log(`tampermonkey jquery loaded successfully`);
    };
    document.getElementsByTagName("head")[0].appendChild(script);
    window.setTimeout(initJQuery, 200);
  }
}

function generateIframe(routeURL) {
  const $ = initJQuery();
  if (!$) {
    unsafeWindow.console.log(`tampermonkey waiting for jquery to load`);
    window.setTimeout(function () {
      generateIframe(routeURL);
    }, 200);
    return;
  } else {
    let iFrame = $("<div>").css({ padding: "0 11px" }).addClass("misha-iframe-container");
    // Check for Healthie environment
    let mishaURL = isStagingEnv ? "dev.misha.vori.health/" : "misha.vorihealth.com/";

    // Define inner HTML for created div
    // Update in the future to a dedicated component
    // https://dev.misha.vori.health/app/schedule
    iFrame.html(
      '<iframe id="MishaFrame" ' +
        'title="Misha iFrame" ' +
        'style="height: 100vh; width: 100%" ' +
        'src="https://' +
        mishaURL +
        routeURL +
        '"' +
        ">" +
        "</iframe>"
    );
    return iFrame;
  }
}

function waitAppointmentsHome() {
  const $ = initJQuery();
  if (!$) {
    unsafeWindow.console.log(`tampermonkey jquery not loaded`);
    window.setTimeout(waitAppointmentsProfile, 200);
    return;
  } else {
    //check to see if the appointment view contents has loaded
    let appointmentWindow = document.getElementsByClassName("provider-home-appointments");
    if (appointmentWindow.length > 0) {
      unsafeWindow.console.log(`tampermonkey found appointment view`, appointmentWindow.length);
      let appointmentWindowObj = appointmentWindow[0];
      //remove all except first child
      while (appointmentWindowObj.childNodes.length > 1) {
        let childClassName = appointmentWindowObj.lastChild.className;
        unsafeWindow.console.log(`tampermonkey removing child `, childClassName);
        appointmentWindowObj.removeChild(appointmentWindowObj.lastChild);
      }
      const iframe = generateIframe(routeURLs.appointments);
      $(appointmentWindowObj).append(iframe);
    } else {
      //wait for content load
      unsafeWindow.console.log(`tampermonkey waiting appointment view`);
      window.setTimeout(waitAppointmentsHome, 200);
    }
  }
}

function waitAppointmentsProfile() {
  const $ = initJQuery();
  if (!$) {
    unsafeWindow.console.log(`tampermonkey jquery not loaded`);
    window.setTimeout(waitAppointmentsProfile, 200);
    return;
  } else {
    // check to see if the appointment view contents have loaded
    let appointmentWindow = $(".insurance-authorization-section").filter(function () {
      return $(this).find("h1.level-item:contains('Appointments')").length > 0;
    })[0];
    if (appointmentWindow) {
      unsafeWindow.console.log(`tampermonkey found appointment view on user profile`);
      $(appointmentWindow).css({ margin: "0", padding: "3px" });
      // get the parent with class .column.is-6 and change the width to 100%
      let parent = $(appointmentWindow).closest(".column.is-6");
      parent
        .css({
          width: "98%",
          minHeight: "420px",
          maxHeight: "max(60vh, 560px)",
          overflow: "scroll",
          marginTop: "2rem",
          padding: "0",
        })
        .closest(".columns") // also adjust style of grandparent
        .css({
          display: "flex",
          flexDirection: "column",
        });

      // also adjust width of packages section
      $(".insurance-authorization-section.cp-section.with-dropdown-menus-for-packgs")
        .closest(".column.is-6")
        .css("width", "100%");

      // remove all children of appointments section
      while (appointmentWindow.childNodes.length > 0) {
        let childClassName = appointmentWindow.lastChild.className;
        unsafeWindow.console.log(`tampermonkey removing child `, childClassName);
        appointmentWindow.removeChild(appointmentWindow.lastChild);
      }

      const iframe = generateIframe(routeURLs.appointments);
      $(appointmentWindow).append(iframe);
    } else {
      // wait for content load
      unsafeWindow.console.log(`tampermonkey waiting appointment view on user profile`);
      window.setTimeout(waitAppointmentsProfile, 200);
    }
  }
}

function showOverlay(url) {
  const $ = initJQuery();
  if (!$) {
    unsafeWindow.console.log(`tampermonkey waiting for jquery to load`);
    window.setTimeout(showOverlay, 200);
    return;
  } else {
    // Create overlay element
    let overlay = $("<div>").addClass("overlay-dialog").css({
      position: "fixed",
      inset: "0",
      zIndex: "999",
      background: "#000000d9",
      display: "flex",
      flexDirection: "column",
      placeContent: "center",
      alignItems: "center",
      justifyContent: "center",
    });
    $(overlay).on("click", function () {
      if ($(".overlay-dialog")) {
        $(".overlay-dialog").remove();
      }
    });

    // Create close button element
    let closeButton = $("<span>").addClass("close-button").html("&times;").css({
      position: "absolute",
      right: "1rem",
      top: "1rem",
      color: "#fff",
      fontSize: "2.5rem",
      cursor: "pointer",
    });
    $(closeButton).on("click", function () {
      if ($(".overlay-dialog")) {
        $(".overlay-dialog").remove();
      }
    });
    overlay.append(closeButton);

    // Create dialog body element with iframe
    let dialogBody = $("<div>").addClass("dialog-body").css({
      background: "#fff",
      maxWidth: "max(600px, 60vw)",
      width: "100vw",
      height: "80vh",
      height: "80dvh",
      overflowY: "scroll",
    });

    let iframe = generateIframe(url);
    dialogBody.append(iframe); // Append iframe to dialog body
    overlay.append(dialogBody); // Append dialog body to overlay
    const existingOverlay = $(".body").find(".overlay-dialog");

    if (existingOverlay.length === 0) {
      $("body").append(overlay); // Append overlay to body
      unsafeWindow.console.log(`Tampermonkey displayed overlay`);
    }
  }
}

let maxWaitForEvents = 200; // comically high number to prevent infinite loop
let maxWaitForInit = 200; // comically high number to prevent infinite loop
function initCalendar() {
  const $ = initJQuery();
  if (!$) {
    unsafeWindow.console.log(`Tampermonkey jQuery not loaded`);
    window.setTimeout(initCalendar, 200);
    return;
  } else {
    unsafeWindow.console.log(`Tampermonkey initializing calendar`);

    maxWaitForInit--;
    if (maxWaitForInit < 0) {
      window.location.reload();
      return;
    }

    // Check if calendar is loaded and cloned
    if ($(".main-calendar-column").find(".cloned-calendar").length > 0) {
      unsafeWindow.console.log(`Tampermonkey calendar already cloned`);
      return;
    }

    // Check if class .cloned-calendar exists and remove the string from the class name
    $(".cloned-calendar").removeClass("cloned-calendar");

    // First overlay a transparent div on top of the calendar until cloning is done
    const overlay = $("<div>").addClass("overlay-vori").css({
      position: "absolute",
      display: "block",
      inset: "0px",
      zIndex: "9999999",
      background: "ffffff00",
      backdropFilter: "blur(5px)",
      pointerEvents: "none",
      userSelect: "none",
    });
    if (!$(".main-calendar-column").find(".overlay-vori").length > 0) {
      $(".main-calendar-column").css({ position: "relative" }).append(overlay);
      unsafeWindow.console.log(`Tampermonkey added overlay to calendar`);
    }

    // First init add button to make sure event gets overwritten
    initAddButton($);

    // Move on to calendar
    const calendarLoading = $(".day-view.is-loading, .week-view.is-loading, .month-view.is-loading");
    if (calendarLoading.length > 0) {
      unsafeWindow.console.log(`Tampermonkey waiting for calendar to load`);
      window.setTimeout(initCalendar, 200);
      return;
    }

    let calendar = null;
    let calendarEvents = $(".rbc-event.calendar-event.with-label-spacing");
    let calendarHeaderBtns = $(".rbc-btn-group");
    let activeBtn = calendarHeaderBtns.find(".rbc-active");
    let activeTab = $(".calendar-tabs").find(".tab-item.active");
    let calendarTab = activeTab && activeTab.text().toLowerCase().includes("calendar");
    let availabilitiesTab = activeTab && activeTab.text().toLowerCase().includes("availability");

    if (calendarTab) {
      if (
        activeBtn &&
        (activeBtn.text().toLowerCase().includes("day") || activeBtn.text().toLowerCase().includes("week"))
      ) {
        unsafeWindow.console.log(`Tampermonkey calendar is on day or week view`);
        calendar = $(".rbc-time-content");
        let clonedCalendar = calendar.clone(true);
        clonedCalendar.addClass("cloned-calendar");
        calendar.replaceWith(clonedCalendar);
      } else if (activeBtn && activeBtn.text().toLowerCase().includes("month")) {
        unsafeWindow.console.log(`Tampermonkey calendar is on month view`);
        calendar = $(".rbc-month-view");
        if ($(".rbc-month-view").length > 0) {
          let monthView = $(".rbc-month-view")[0].childNodes;
          let children = Array.from(monthView);
          children.forEach((child) => {
            let clone = $(child).clone();
            $(clone).addClass("cloned");
            $(child).replaceWith(clone);
          });
        }
      }
    } else if (availabilitiesTab) {
      unsafeWindow.console.log(`Tampermonkey calendar is on availability tab`);
      calendar = $(".rbc-time-content");
      let clonedCalendar = calendar.clone(true);
      clonedCalendar.addClass("cloned-calendar");
      calendar.replaceWith(clonedCalendar);
    }

    if (calendar) {
      // Event listeners
      $(".rbc-time-slot, .rbc-day-bg").on("click", function (e) {
        e.stopPropagation();
        showOverlay(routeURLs.appointments.create);
      });
      $(".rbc-event.calendar-event").on("click", function (e) {
        e.stopPropagation();
        showOverlay(routeURLs.appointments.view);
      });
      $(".cloned-calendar") && unsafeWindow.console.log(`Tampermonkey calendar cloned`);
      $(".overlay-vori").remove();
    } else {
      maxWaitForEvents--;
      if (maxWaitForEvents === 0) {
        window.location.reload();
      } else {
        unsafeWindow.console.log(`Tampermonkey waiting for calendar and events`);
        window.setTimeout(initCalendar, 200);
      }
    }
  }
}

function initAddButton() {
  if (!$) {
    unsafeWindow.console.log(`tampermonkey waiting for jquery to load`);
    window.setTimeout(showOverlay, 200);
    return;
  } else {
    let addAppointmentBtn = $(".rbc-btn-group.last-btn-group").find("button:contains('Add')")[0];
    if (addAppointmentBtn) {
      let clonedBtn = $(addAppointmentBtn).clone();
      $(addAppointmentBtn).replaceWith(clonedBtn);
      clonedBtn.on("click", function (e) {
        e.stopPropagation();
        showOverlay(routeURLs.appointments.create);
      });
    } else {
      unsafeWindow.console.log(`tampermonkey waiting for add appointment button`);
      window.setTimeout(waitAddAppointmentsBtn, 200);
    }
  }
}

function observeCalendarChanges(mutations, observer) {
  const targetClasses = ["rbc-time-content", "rbc-month-view"];

  for (const mutation of mutations) {
    const { target, addedNodes, removedNodes } = mutation;

    // Check if the mutation target or any added/removed node has one of the target classes or if the children of these classes have changed
    if (
      (target && targetClasses.some((className) => target.classList.contains(className))) ||
      (addedNodes &&
        [...addedNodes].some(
          (addedNode) =>
            addedNode.nodeType === Node.ELEMENT_NODE &&
            targetClasses.some((className) => addedNode.classList.contains(className))
        )) ||
      (removedNodes &&
        [...removedNodes].some(
          (removedNode) =>
            removedNode.nodeType === Node.ELEMENT_NODE &&
            targetClasses.some((className) => removedNode.classList.contains(className))
        )) ||
      (addedNodes &&
        [...addedNodes].some(
          (addedNode) =>
            addedNode.nodeType === Node.ELEMENT_NODE &&
            targetClasses.some((className) => addedNode.querySelector(`.${className}`))
        )) ||
      (removedNodes &&
        [...removedNodes].some(
          (removedNode) =>
            removedNode.nodeType === Node.ELEMENT_NODE &&
            targetClasses.some((className) => removedNode.querySelector(`.${className}`))
        ))
    ) {
      // Disconnect the observer temporarily to prevent observing during the cloning process
      observer.disconnect();
      initCalendar();
      observer.observe(document.documentElement, { childList: true, subtree: true });
      break; // We executed initCalendar() once, no need to check further
    }
  }
}

let calendarInitialized = false;
function waitCalendar() {
  if (!calendarInitialized) {
    initCalendar();
    calendarInitialized = true;
  }
  const observer = new MutationObserver(observeCalendarChanges);
  const targetNode = document.documentElement;
  const config = { childList: true, subtree: true };
  observer.observe(targetNode, config);
}

function waitAddAppointmentsBtn() {
  const $ = initJQuery();
  if (!$) {
    unsafeWindow.console.log(`tampermonkey jquery not loaded`);
    window.setTimeout(waitAppointmentsProfile, 200);
    return;
  } else {
    initAddButton($);
  }
}

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

    // let's add a div with the text "Loading Careplan..."
    const loadingDiv = document.createElement("div");
    loadingDiv.classList.add("vori-loading-message");
    loadingDiv.textContent = "Loading Careplan...";
    loadingDiv.style.textAlign = "center";
    loadingDiv.style.margin = "1.8rem";
    loadingDiv.style.fontSize = "18px";
    const loadingDivExists = document.querySelector(".vori-loading-message");
    if (!loadingDivExists) {
      parent && parent.appendChild(loadingDiv);
    }

    const patientNumber = location.href.split("/")[location.href.split("/").length - 2];

    //setup message divs and links
    const iframeMsgDiv = document.createElement("div");
    iframeMsgDiv.classList.add("vori-iframe-message");
    iframeMsgDiv.style.display = "block";
    iframeMsgDiv.style.position = "relative";
    iframeMsgDiv.style.background = "rgb(227 229 50 / 21%)";
    iframeMsgDiv.style.margin = "1.8rem";
    iframeMsgDiv.style.textAlign = "center";
    iframeMsgDiv.style.padding = "7rem 7vw";

    const iframeMsgLink = document.createElement("a");
    iframeMsgLink.style.color = "#333";
    iframeMsgLink.style.fontSize = "18px";
    iframeMsgLink.style.letterSpacing = "0.3px";
    iframeMsgLink.style.textDecoration = "none";

    if (healthieAPIKey === "") {
      let iframeMsgExists = document.querySelector(".vori-iframe-message");
      if (!iframeMsgExists) {
        iframeMsgLink.textContent =
          "You cannot view Care Plan's until you connect your Healthie Account to Vori Health. Set it up here!";
        iframeMsgLink.href = "/settings/api_keys";

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

        parent && parent.removeChild(loadingDiv);
        parent && parent.appendChild(iframeMsgDiv);
      }
    } else if (healthieAPIKey !== "") {
      // let's get the user data
      const getUserQuery = `query {
        user(id: "${patientNumber}") {
          id
          additional_record_identifier
        }
      }`;

      const getUserPayload = JSON.stringify({ query: getUserQuery });
      goalMutation(getUserPayload).then((response) => {
        unsafeWindow.console.log(`tampermonkey get user response`, response);
        const mishaID = response.data.user.additional_record_identifier;
        unsafeWindow.console.log(`tampermonkey mishaID`, mishaID);

        if (mishaID === "" || mishaID === null) {
          let iframeMsgExists = document.querySelector(".vori-iframe-message");
          if (!iframeMsgExists) {
            iframeMsgDiv.style.whiteSpace = "pre-line";
            iframeMsgDiv.style.color = "#333";
            iframeMsgDiv.style.fontSize = "18px";
            iframeMsgDiv.style.letterSpacing = "0.3px";
            iframeMsgDiv.style.lineHeight = "1.5";
            iframeMsgDiv.textContent =
              "This patient's account has not been linked. \r\n Please contact Vori Health tech team to set it up!";

            parent && parent.removeChild(loadingDiv);
            parent && parent.appendChild(iframeMsgDiv);
          }
        } else {
          //Create Div
          var iFrameNode = document.createElement("div");
          //Check for Healthie environment
          let iFrameURL = isStagingEnv ? "dev.misha.vori.health/" : "misha.vorihealth.com/";

          //Define inner HTML for created div
          iFrameNode.innerHTML =
            '<iframe id="MishaFrame"' +
            'title="Misha iFrame"' +
            'style="height: 100vh; width: 100%"' +
            'src="https://' +
            iFrameURL +
            mishaID +
            '/careplan"' +
            ">" +
            "</iframe>";
          iFrameNode.setAttribute("class", "cp-tab-contents");

          parent && parent.removeChild(loadingDiv);
          parent && parent.appendChild(iFrameNode);

          //remove styling of healthie tab element
          document.getElementsByClassName("column is-12 is-12-mobile")[0].style = "";

          //due to XSS constraints listen for post message from Misha when care plan is submitted to update Healthie
          //confirming publishing of care plan will trigger window.parent.postMessage within Misha
          window.onmessage = function (event) {
            //check event to see if is care plan message
            if (event.data.tmInput !== undefined) {
              // let's get all user goals and delete them before adding new ones
              const getGoalQuery = `query {
                  goals(user_id: "${patientNumber}", per_page: 100) {
                    id,
                    name
                  }
                }
                `;
              const getGoalPayload = JSON.stringify({ query: getGoalQuery });
              goalMutation(getGoalPayload).then((response) => {
                const allGoals = response.data.goals;
                unsafeWindow.console.log("tampermonkey all goals", response);

                // delete all goals
                allGoals.forEach((goal) => {
                  const deleteGoalQuery = `mutation {
                  deleteGoal(input: {id: "${goal.id}"}) {
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
                  const deleteGoalPayload = JSON.stringify({
                    query: deleteGoalQuery,
                  });
                  goalMutation(deleteGoalPayload).then((response) => {
                    unsafeWindow.console.log("tampermonkey deleted goal", response);
                  });
                });

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
              });
            }
          };
        }
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

    if (storedApiKey === "") {
      newInput.value = storedApiKey; // Set the initial value of the input
    } else {
      newInput.value = "***************"; // show mask indicating that a valid key is stored
    }

    // Add onclick handler to the "Link Api key" button
    newButton.onclick = function () {
      let apiKey = newInput.value.trim(); // Trim whitespace from the input value
      if (apiKey === "") {
        alert("Please enter a valid API key!");
      } else {
        const patientNumber = location.href.split("/")[location.href.split("/").length - 2];
        healthieAPIKey = apiKey;
        auth = `Basic ${healthieAPIKey}`;

        // let's check that we can get goals successfully
        const getGoalQuery = `query {
                              goals {
                                id
                                name
                              }
                            }
                            `;
        const getGoalPayload = JSON.stringify({ query: getGoalQuery });
        goalMutation(getGoalPayload).then((response) => {
          unsafeWindow.console.log(`tampermonkey api key goals response: ${JSON.stringify(response)}`);

          if (response.errors) {
            alert("That is not a valid API key. Please verify the key and try again.");
          } else {
            GM_setValue("healthieApiKey", apiKey);
            alert("API key saved successfully!");
            window.setTimeout(null, 2000);
            window.location.reload();
          }
        });
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

function setGeneralTab() {
  let generalTab = document.querySelector('[data-testid="activetab-general"]');
  unsafeWindow.console.log(`tampermonkey general tab is`, generalTab);
  generalTab &&
    generalTab.addEventListener(
      "click",
      function () {
        unsafeWindow.console.log(`tampermonkey clicked general tab`, generalTab);
        waitAppointmentSidebar();
        window.setTimeout(function () {
          setAppointmentCollapse();
        }, 600);
      },
      false
    );
}

function setAppointmentCollapse() {
  let appointmentSectionTitle = document.querySelector('[data-testid="cp-section-appointments"]');
  appointmentSectionTitle &&
    appointmentSectionTitle.addEventListener(
      "click",
      function () {
        unsafeWindow.console.log(`tampermonkey clicked section title`, appointmentSectionTitle.className);
        appointmentSectionTitle.className != "cp-sidebar-expandable-section undefined opened" &&
          waitAppointmentSidebar();
      },
      false
    );
}

function waitInfo() {
  let infoButton = document.getElementsByClassName("right-menu-trigger is-hidden-mobile")[0];
  if (infoButton) {
    window.setTimeout(function () {
      setGeneralTab();
      setAppointmentCollapse();
    }, 600);
    infoButton.addEventListener(
      "click",
      function () {
        window.setTimeout(function () {
          let appointmentWindow = document.querySelector('[data-testid="cp-section-appointments"]');
          unsafeWindow.console.log(`tampermonkey info clicked`, appointmentWindow);
          setGeneralTab();
          setAppointmentCollapse();
          appointmentWindow && waitAppointmentSidebar();
        }, 500);
      },
      false
    );
  } else {
    window.setTimeout(waitInfo, 500);
  }
}

function waitAppointmentSidebar() {
  let appointmentWindow = document.querySelector('[data-testid="cp-section-appointments"]');
  let goalsTab = document.querySelector('[data-testid="tab-goals"]');
  unsafeWindow.console.log(`tampermonkey goals tab `, goalsTab);
  goalsTab && goalsTab.remove();
  let actionLinks = Array.from(document.getElementsByClassName("healthie-action-link"));
  if (appointmentWindow && actionLinks[0]) {
    goalsTab && goalsTab.remove();
    actionLinks.forEach((element) => {
      unsafeWindow.console.log("tampermonkey action link found", element);
      element.remove();
    });
  } else {
    //wait for content load
    unsafeWindow.console.log(`tampermonkey waiting to hide chat links`);
    window.setTimeout(waitAppointmentSidebar, 500);
  }
}

initJQuery();

//config for observer
const config = { subtree: true, childList: true };
observer.observe(document, config);

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
