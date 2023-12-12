<<<<<<< HEAD
// ==UserScript==
// @name         Healthie Care Plan Integration
// @namespace    http://tampermonkey.net/
// @version      0.73
// @description  Injecting care plan components into Healthie
// @author       Don, Tonye, Alejandro
// @match        https://*.gethealthie.com/*
// @match        https://vorihealth.gethealthie.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=vori.health
// @sandbox      JavaScript
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

/* globals contentful */

//Enable/Disable debug mode
let debug = false;
let previousUrl = "";
let patientNumber = "";
let carePlanLoopLock = 0;
//Keep track of timeouts
let timeoutIds = [];
// Check for Healthie environment
const isStagingEnv = location.href.includes("securestaging") ? true : false;
let mishaURL = isStagingEnv ? "qa.misha.vori.health/" : "misha.vorihealth.com/";
let healthieURL = isStagingEnv ? "securestaging.gethealthie.com" : "vorihealth.gethealthie.com";
let healthieAPIKey = GM_getValue(isStagingEnv ? "healthieStagingApiKey" : "healthieApiKey","");
let auth = `Basic ${healthieAPIKey}`;
const urlValidation = {
  apiKeys: /\/settings\/api_keys$/,
  appointments: /\/appointments|\/organization|\/providers\//,
  appointmentsHome: /^https?:\/\/[^/]+\.com(\/overview|\/)?$/,
  appointmentsProfile:/^https?:\/\/([^\/]+)?\.?([^\/]+)\/users\/\d+(?:\/(?:Overview))?\/?$/,
  membership:/^https?:\/\/([^\/]+)?\.?([^\/]+)\/users\/\d+(?:\/(?:Overview|Actions))?\/?$/,
  verifyEmailPhone:/^https?:\/\/([^\/]+)?\.?([^\/]+)\/users\/\d+(?:\/(?:Actions))\/?$/,
  carePlan: /\/all_plans$/,
  clientList: /\/clients\/active/,
  conversations: /\/conversations/,
  goals: /\/users/,
};
let copyComplete = -1;
let delayedRun = 0;
let replaceCalendar = false;
let isEmailVerified = true;
let isPhoneNumberVerified = true;
let isLoadingEmailPhone = true;

function debugLog(...messages) {
  if (isStagingEnv || debug) {
    unsafeWindow.console.log(...messages);
  }
}
const routeURLs = {
  schedule: "schedule",
  careplan: "careplan",
  goals: "app/schedule",
  appointment: "appointment",
  appointments: "appointments",
  patientStatus: "patientStatusStandalone",
  providerSchedule: "provider-schedule",
  otpVerify: "otpVerifyStandalone",
  createPatientDialog: "createPatientDialog",
};

const styles = {
  scheduleOverlay: {
    display: "inline-block",
    background: "rgb(255, 255, 255)",
    maxWidth: "90vw", // fallback for browsers that don't support svw
    maxWidth: "90svw",
    width: "100vw",
    height: "90vh", // fallback for browsers that don't support svh
    height: "90svh",
    overflow: "hidden",
  },
  patientDialogOverlay: {
    display: "inline-block",
    background: "rgb(255, 255, 255)",
    maxWidth: "30vw", // fallback for browsers that don't support svw
    maxWidth: "60svw",
    width: "30vw",
    height: "80vh", // fallback for browsers that don't support svh
    height: "80svh",
    overflow: "hidden",
  },
  appointmentDetailsOverlay: {
    height: "350px",
    width: "100%",
    overflow: "hidden",
  },
  otpOverlay: {
    width: "500px",
    height: "500px",
  },
};

function createTimeout(timeoutFunction, delay) {
  let timeoutId = window.setTimeout(() => {
    timeoutFunction();
    // Remove timeoutId from the array after function execution
    // debugLog(`tampermonkey remove timeout ${timeoutId}`);
    timeoutIds = timeoutIds.filter((id) => id !== timeoutId);
  }, delay);
  //debugLog(`tampermonkey create timeout ${timeoutId}`);
  timeoutIds.push(timeoutId);
  return timeoutId;
}

function clearAllTimeouts() {
  debugLog(`tampermonkey clear all timeouts`);
  timeoutIds.forEach((id) => {
    window.clearTimeout(id);
  });
  timeoutIds = [];
}

function clearMyTimeout(timeoutId) {
  if (!timeoutId) {
    return;
  }
  debugLog(`tampermonkey clear timeout ${timeoutId}`);
  window.clearTimeout(timeoutId);
  timeoutIds = timeoutIds.filter((id) => id !== timeoutId);
}

function initJQuery() {
  let $ = unsafeWindow.jQuery;
  if ($ && $ !== undefined && typeof $ === "function") {
    return $;
  } else {
    debugLog(`tampermonkey waiting for jquery to load`);
    let script = document.createElement("script");
    script.src = "https://code.jquery.com/jquery-3.7.0.min.js";
    script.type = "text/javascript";
    script.onload = function () {
      debugLog(`tampermonkey jquery loaded successfully`);
    };
    document.getElementsByTagName("head")[0].appendChild(script);
    createTimeout(initJQuery, 200);
  }
}
initJQuery();

function convertToCSSProperty(jsProperty) {
  return jsProperty.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function generateIframe(routeURL, options = {}) {
  const $ = initJQuery();

  className = "misha-iframe-container";
  const iframeStyles = {
    height: options.height || "100vh",
    width: options.width || "100%",
    ...options,
  };
  // Convert iframeStyles object to CSS string
  const iframeStyleString = Object.entries(iframeStyles)
    .map(([property, value]) => `${convertToCSSProperty(property)}: ${value};`)
    .join(" ");

  if (!$) {
    debugLog(`tampermonkey waiting for jquery to load`);
    createTimeout(function () {
      generateIframe(routeURL);
    }, 200);
    return;
  } else {
    const iframeElement = $("<div>")
      .css({ padding: "0", ...options })
      .addClass(className);

    const iframeContent = $("<iframe>", {
      id: "MishaFrame",
      title: "Misha iFrame",
      style: iframeStyleString,
      src: `https://${mishaURL}${routeURL}`,
    });
    iframeElement.append(iframeContent);
    return iframeElement;
  }
}

function waitAppointmentsHome() {
  const $ = initJQuery();
  if (!$) {
    debugLog(`tampermonkey jquery not loaded`);
    createTimeout(waitAppointmentsHome, 200);
    return;
  } else {
    //check to see if the appointment view contents has loaded
    let appointmentWindow = document.getElementsByClassName(
      "provider-home-appointments"
    );
    if (appointmentWindow.length > 0) {
      debugLog(`tampermonkey found appointment view`, appointmentWindow.length);
      let appointmentWindowObj = appointmentWindow[0];
      //remove all except first child
      while (appointmentWindowObj.childNodes.length > 1) {
        let childClassName = appointmentWindowObj.lastChild.className;
        debugLog(`tampermonkey removing child `, childClassName);
        appointmentWindowObj.removeChild(appointmentWindowObj.lastChild);
      }

      // get the patient number from the URL
      patientNumber =
        location.href.split("/")[location.href.split("/").length - 1];

      // get the user data for provider id
      const getCurrentUserQuery = `query user{
        user(or_current_user: true){
         id
       }
       }`;

      const getCurrentUserPayload = JSON.stringify({
        query: getCurrentUserQuery,
      });
      healthieGQL(getCurrentUserPayload).then((response) => {
        const userId = response.data.user.id;
        //provider-schedule/id
        const iframeSrc = `https://${mishaURL}${routeURLs.providerSchedule}/${userId}`;

        // Check if the iframe already exists
        let existingIframe = document.querySelector(
          `iframe[src="${iframeSrc}"]`
        );
        // If the iframe doesn't exist, create a new one
        if (!existingIframe) {
          const iframe = generateIframe(
            `${routeURLs.providerSchedule}/${userId}`
          );
          $(appointmentWindowObj).append(iframe);
        }
      });
    } else {
      //wait for content load
      debugLog(`tampermonkey waiting appointment view`);
      createTimeout(waitAppointmentsHome, 200);
    }
  }
}

function initBookAppointmentButton() {

  if (!$) {
    debugLog(`tampermonkey waiting for jquery to load`);
    createTimeout(showOverlay, 200);
    return;
  } else {
    let bookAppointmentBtn = $(".insurance-authorization-section").find(
      "button:contains('Book Appointment')"
    )[0];
    if (bookAppointmentBtn) {
      let patientNumber = location.href.split("/")[4];
      let clonedBtn = $(bookAppointmentBtn).clone();
      $(bookAppointmentBtn).replaceWith(clonedBtn);
      clonedBtn.on("click", function (e) {
        e.stopPropagation();
        showOverlay(
          `${routeURLs.schedule}/${patientNumber}`,
          styles.scheduleOverlay
        );
      });
    } else {
      debugLog(`tampermonkey waiting for book appointment button`);
      createTimeout(initBookAppointmentButton, 200);
    }
  }
}

function createPatientDialogIframe() {
  if (!$) {
    debugLog(`tampermonkey waiting for jQuery to load`);
    setTimeout(createPatientDialogIframe, 200);
    return;
  }
  debugLog(`jQuery is loaded, attempting to find 'Add Client' button`);
  let addPatientBtn = $(".add-client-container button:contains('Add Client')")[0];
  if (addPatientBtn) {
    debugLog(`'Add Client' button found, proceeding to clone`);
    let clonedBtn = $(addPatientBtn).clone();
    $(addPatientBtn).replaceWith(clonedBtn);
    clonedBtn.on("click", (e) => {
      debugLog(`Cloned 'Add Client' button clicked`);
      e.stopPropagation();
      showOverlay(`${routeURLs.createPatientDialog}`, styles.patientDialogOverlay);
    });
  } else {
    debugLog(`'Add Client' button not found, retrying...`);
    setTimeout(createPatientDialogIframe, 200);
  }
}

function waitForAddPatientButton() {
  const $ = initJQuery();
  if ($(".add-client-container button:contains('Add Client')").length > 0) {
    debugLog("Add Client Button found");
    createPatientDialogIframe();
  } else {
    debugLog("Waiting for 'Add Client' button");
    setTimeout(waitForAddPatientButton, 200);
  }
}

function waitAppointmentsProfile() {
  const $ = initJQuery();
  if (!$) {
    debugLog(`tampermonkey jquery not loaded`);
    createTimeout(waitAppointmentsProfile, 200);
    return;
  } else {
    initBookAppointmentButton();
    // check to see if the appointment view contents have loaded
    let appointmentWindow = $(".insurance-authorization-section div").filter(
      function () {
        return $(this).find(".tabs.apps-tabs").length > 0;
      }
    )[0];
    if (appointmentWindow) {
      debugLog(`tampermonkey found appointment view on user profile`);
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
      $(
        ".insurance-authorization-section.cp-section.with-dropdown-menus-for-packgs"
      )
        .closest(".column.is-6")
        .css("width", "100%");

      // remove all children of appointments section
      while (appointmentWindow.childNodes.length > 0) {
        let childClassName = appointmentWindow.lastChild.className;
        debugLog(`tampermonkey removing child `, childClassName);
        appointmentWindow.removeChild(appointmentWindow.lastChild);
      }

      // example of url to load - https://securestaging.gethealthie.com/users/388687
      // can also be - https://securestaging.gethealthie.com/users/388687/Overview
      const patientID = location.href.split("/")[4];
      const iframe = generateIframe(
        `${routeURLs.appointments}/patient/${patientID}`
      );
      $(appointmentWindow).append(iframe);
    } else {
      // wait for content load
      debugLog(`tampermonkey waiting appointment view on user profile`);
      createTimeout(waitAppointmentsProfile, 200);
    }
  }
}

function hideOverlay() {
  const $ = initJQuery();
  if (!$) {
    debugLog(`tampermonkey waiting for jquery to load`);
    createTimeout(hideOverlay, 200);
    return;
  } else {
    $(".overlay-dialog").remove();
    debugLog(`Tampermonkey removed overlay`);
  }
}

function showOverlay(url, style = {}) {
  const $ = initJQuery();
  if (!$) {
    debugLog(`tampermonkey waiting for jquery to load`);
    createTimeout(showOverlay, 200);
    return;
  } else {
    hideOverlay();
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
    let dialogBody = $("<div>")
      .addClass("dialog-body")
      .css({
        background: "#fff",
        maxWidth: "max(600px, 60vw)",
        width: "100vw",
        height: "80vh",
        height: "80dvh",
        overflowY: "scroll",
        ...style,
      });

    let iframe = generateIframe(url, style);
    dialogBody.append(iframe); // Append iframe to dialog body
    overlay.append(dialogBody); // Append dialog body to overlay
    const existingOverlay = $(".body").find(".overlay-dialog");

    if (existingOverlay.length === 0) {
      $("body").append(overlay); // Append overlay to body
      debugLog(`Tampermonkey displayed overlay`);
    }
  }
}

function showBothCalendars(clonedCalendar, ogCalendar) {
  clonedCalendar.css({
    position: "absolute",
    transform: "translate(-46%, 35px)",
    left: "0px",
    width: "67%",
    maxWidth: "750px",
    background: "rgb(255, 255, 255)",
  });
  let cssRules = `
          .rbc-time-content>.rbc-time-gutter {
            display: none;
          }
          #big-calendar-container-id > div > div.rbc-time-view > div.rbc-time-content.cloned-calendar > div:nth-child(2),
          #big-calendar-container-id > div > div.rbc-time-view > div.rbc-time-content.cloned-calendar > div:nth-child(8),
          #big-calendar-container-id > div > div.rbc-time-view > div.rbc-time-content.og-calendar > div:nth-child(2),
          #big-calendar-container-id > div > div.rbc-time-view > div.rbc-time-content.og-calendar > div:nth-child(8) {
            display: none;
          }
          .rbc-time-content.cloned-calendar::before,
          .rbc-month-view.cloned-calendar::before {
            content: "Clone";
            position: absolute;
            top: 0px;
            background: #4caf50d1;
            font-size: 40px;
            line-height: 1.5;
            font-weight: bold;
            text-transform: uppercase;
            color: #000;
            z-index: 99999999;
          }
        `;
  let cssRuleToCheck = ".rbc-time-content.cloned-calendar::before";
  let styleElementExists =
    $("style").filter(function () {
      return $(this).text().indexOf(cssRuleToCheck) !== -1;
    }).length > 0;
  if (!styleElementExists) {
    let styleElement = document.createElement("style");
    styleElement.appendChild(document.createTextNode(cssRules));
    $("head").append(styleElement);
  }

  ogCalendar.css({
    position: "absolute",
    transform: "translate(54%, 35px)",
    border: "4px solid rgb(255, 92, 92)",
    zIndex: "9",
    width: "63%",
    background: "#fff",
  });
  cssRules = `
          .rbc-time-content.og-calendar::before,
          .rbc-month-view.og-calendar::before {
            content: "Original";
            position: absolute;
            top: 0px;
            background: #ff3232d1;
            font-size: 40px;
            line-height: 1.5;
            font-weight: bold;
            text-transform: uppercase;
            color: #000;
            z-index: 99999999;
          }
        `;
  cssRuleToCheck = ".rbc-time-content.og-calendar::before";
  styleElementExists =
    $("style").filter(function () {
      return $(this).text().indexOf(cssRuleToCheck) !== -1;
    }).length > 0;
  if (!styleElementExists) {
    let styleElement = document.createElement("style");
    styleElement.appendChild(document.createTextNode(cssRules));
    $("head").append(styleElement);
  }
}

function initSidebarCalendar() {
  let ogSdbrCalendar = $(".react-datepicker__month-container");
  let sidebarTimeout = null;
  if (!ogSdbrCalendar) {
    debugLog(`Tampermonkey waiting for sidebar calendar`);
    sidebarTimeout = createTimeout(initSidebarCalendar, 200);
    return;
  } else {
    debugLog(`Tampermonkey found sidebar calendar`);
    clearMyTimeout(sidebarTimeout);
    // create style element to disable pointer events on calendar
    let cssRules = `
          .react-datepicker__month-container {
            pointer-events: none;
            user-select: none;
          }
          .react-datepicker__navigation {
            pointer-events: none;
            user-select: none;
          }
        `;
    let cssRuleToCheck = ".react-datepicker__month-container";
    let styleElementExists =
      $("style").filter(function () {
        return $(this).text().indexOf(cssRuleToCheck) !== -1;
      }).length > 0;
    if (!styleElementExists) {
      let styleElement = document.createElement("style");
      styleElement.appendChild(document.createTextNode(cssRules));
      $("head").append(styleElement);
    }
  }
}

let maxWaitForEvents = 500; // comically high number to prevent infinite loop
let maxWaitForInit = 500; // comically high number to prevent infinite loop
let maxWaitForCalendarLoad = 1500; // comically high number to prevent infinite loop
let initCalTimeout = null;
function initCalendar(replaceCalendar) {
  const $ = initJQuery();
  if (!$) {
    debugLog(`Tampermonkey jQuery not loaded`);
    initCalTimeout = createTimeout(function () {
      initCalendar(replaceCalendar);
    }, 200);
    return;
  } else {
    clearMyTimeout(initCalTimeout); // clear jquery timeout
    debugLog(
      `Tampermonkey initializing calendar. maxWait: [${maxWaitForInit}, ${maxWaitForCalendarLoad}], delayedRun: ${delayedRun}, replaceCalendar: ${replaceCalendar}`
    );

    maxWaitForInit--;
    maxWaitForCalendarLoad--;
    if (maxWaitForInit < 0 || maxWaitForCalendarLoad < 0) {
      window.location.reload();
      return;
    }

    maxWaitForInit = 500;
    let calendar = null;
    let calendarHeaderBtns = $(".rbc-btn-group");
    let activeBtn = calendarHeaderBtns.find(".rbc-active");
    let activeTab = $(".calendar-tabs").find(".tab-item.active");
    let calendarTab =
      activeTab && activeTab.text().toLowerCase().includes("calendar");
    let availabilitiesTab =
      activeTab && activeTab.text().toLowerCase().includes("availability");

    debugLog(`Tampermonkey copyComplete`, copyComplete);
    // Check if we're on availabilities tab, or if  calendar is loaded and cloned
    if (
      availabilitiesTab ||
      (!replaceCalendar &&
        $(".main-calendar-column").find(".cloned-calendar").length > 0) ||
      copyComplete > 500 ||
      copyComplete < 0
    ) {
      return;
    }

    if (replaceCalendar) {
      debugLog(`Tampermonkey force re-init calendar`);
      $(".cloned-calendar").remove(); // remove all instances of existing cloned calendar
    }

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

    // First init add button to make sure event gets overwritten
    initAddButton();
    initCalendarHeaderBtns();

    // check if calendar is loading
    const calendarLoading = $(
      ".day-view.is-loading, .week-view.is-loading, .month-view.is-loading"
    );
    if (calendarLoading.length > 0) {
      debugLog(`Tampermonkey waiting for calendar to load`);
      if (!$(".main-calendar-column").find(".overlay-vori").length > 0) {
        $(".main-calendar-column")
          .css({ position: "relative" })
          .append(overlay);
        debugLog(`Tampermonkey added overlay to calendar`);
      }
      initCalTimeout = createTimeout(function () {
        initCalendar(replaceCalendar);
      }, 1000);
      return;
    } else {
      maxWaitForCalendarLoad = 1500;
      $(".overlay-vori").remove();
    }

    // wait 1 second then proceed to clone calendar
    delayedRun++;
    createTimeout(function () {
      initCalendar(replaceCalendar);
      copyComplete++;
    }, 1000);

    let cssRules = `
          .rbc-calendar {
            position: relative;
          }
          .cloned-calendar {
            position: absolute;
            top: 64px;
            width: 100.8%;
            background: #fff;
          }
          .cloned-calendar.rbc-month-view {
            top: 60px;
          }
        `;
    let cssRuleToCheck = ".cloned-calendar";
    let styleElementExists =
      $("style").filter(function () {
        return $(this).text().indexOf(cssRuleToCheck) !== -1;
      }).length > 0;
    if (!styleElementExists) {
      let styleElement = document.createElement("style");
      styleElement.appendChild(document.createTextNode(cssRules));
      $("head").append(styleElement);
    }

    if (calendarTab) {
      initSidebarCalendar();
      if (
        activeBtn &&
        (activeBtn.text().toLowerCase().includes("day") ||
          activeBtn.text().toLowerCase().includes("week")) &&
        copyComplete > 0
      ) {
        debugLog(`Tampermonkey calendar is on day or week view`);
        calendar = $(".rbc-time-content");
        let ogCalendar = calendar && calendar.first().addClass("og-calendar");
        let clonedCalendar = ogCalendar.clone(true);
        clonedCalendar
          .addClass("cloned-calendar")
          .removeClass("og-calendar")
          .removeAttr("style");

        // debug mode - set to True for quick debugging
        debug && showBothCalendars(clonedCalendar, ogCalendar);

        // instead of replacing the original calendar, we'll hide it, and append the cloned calendar
        !debug &&
          ogCalendar.css({
            display: "none",
            position: "absolute",
            transform: "translateX(68%)",
          });
        ogCalendar.parent().append(clonedCalendar);
        debugLog(
          `Tampermonkey hid original calendar and appended cloned calendar - day/week view`
        );
      } else if (
        activeBtn &&
        activeBtn.text().toLowerCase().includes("month") &&
        copyComplete > 0
      ) {
        debugLog(`Tampermonkey calendar is on month view`);
        calendar = $(".rbc-month-view");
        let ogCalendar = calendar && calendar.first().addClass("og-calendar");

        if (ogCalendar.length > 0) {
          let clonedCalendar = ogCalendar.clone(true);
          let monthView = clonedCalendar[0].childNodes;
          let children = Array.from(monthView);
          children.forEach((child) => {
            let clone = $(child).clone();
            $(clone).addClass("cloned");
            $(child).replaceWith(clone);
          });

          clonedCalendar
            .addClass("cloned-calendar")
            .removeClass("og-calendar")
            .removeAttr("style");
          debug && showBothCalendars(clonedCalendar, ogCalendar);
          !debug &&
            ogCalendar.css({
              display: "none",
              position: "absolute",
              transform: "translateX(68%)",
            });
          ogCalendar.parent().append(clonedCalendar);
          debugLog(
            `Tampermonkey hid original calendar and appended cloned calendar - day/week view`
          );
        }
      }
    }

    if (calendar) {
      maxWaitForEvents = 500;
      // Event listeners
      $(".rbc-time-slot, .rbc-day-bg").on("click", function (e) {
        e.stopPropagation();
        showOverlay(`${routeURLs.schedule}`, styles.scheduleOverlay);
      });
      $(".rbc-event.calendar-event").on("click", function (e) {
        e.stopPropagation();
        const dataForValue = $(this).attr("data-for");
        const apptUuid = dataForValue.split("__")[1].split("_")[0];
        //appointment/appointment id
        showOverlay(
          `${routeURLs.appointment}/${apptUuid}`,
          styles.appointmentDetailsOverlay
        );
      });
      $(".cloned-calendar") && debugLog(`Tampermonkey calendar cloned`);
      copyComplete = -1;
      debugLog(
        `reset copy complete in initCalendar after cloning`,
        copyComplete
      );
      let clonedCalendar = $(".cloned-calendar");
      clonedCalendar && clearMyTimeout(initCalTimeout);
      $(".overlay-vori").remove();
    } else {
      maxWaitForEvents--;
      if (maxWaitForEvents === 0) {
        window.location.reload();
      } else {
        debugLog(`Tampermonkey waiting for calendar and events`);
        createTimeout(function () {
          initCalendar(replaceCalendar);
        }, 1000);
      }
    }
  }
}

function initAddButton() {
  const $ = initJQuery();
  if (!$) {
    debugLog(`tampermonkey waiting for jquery to load`);
    createTimeout(showOverlay, 200);
    return;
  } else {
    let activeTab = $(".calendar-tabs").find(".tab-item.active");
    let availabilitiesTab =
      activeTab && activeTab.text().toLowerCase().includes("availability");

    if (availabilitiesTab) {
      debugLog(
        `Tampermonkey calendar is on availability tab - nothing to do here`
      );
      return;
    }

    let addAppointmentBtn = $(".rbc-btn-group.last-btn-group").find(
      "button:contains('Add')"
    )[0];
    if (addAppointmentBtn) {
      let clonedBtn = $(addAppointmentBtn).clone();
      $(addAppointmentBtn).replaceWith(clonedBtn);
      clonedBtn.on("click", function (e) {
        e.stopPropagation();
        //https://qa.misha.vori.health/schedule/
        showOverlay(`${routeURLs.schedule}`, styles.scheduleOverlay);
      });
    } else {
      debugLog(`tampermonkey waiting for add appointment button`);
      createTimeout(waitAddAppointmentsBtn, 200);
    }
  }
}

function initCalendarHeaderBtns() {
  const $ = initJQuery();
  if (!$) {
    debugLog(`tampermonkey waiting for jquery to load`);
    createTimeout(showOverlay, 200);
    return;
  } else {
    debugLog(`tampermonkey calendar initializing today, prev, next buttons`);
    let activeTab = $(".calendar-tabs").find(".tab-item.active");
    let availabilitiesTab =
      activeTab && activeTab.text().toLowerCase().includes("availability");

    if (availabilitiesTab) {
      debugLog(
        `Tampermonkey calendar is on availability tab - nothing to do here`
      );
      return;
    }

    let dayBtn = $(".rbc-btn-group").find("button:contains('day')")[0];
    let weekBtn = $(".rbc-btn-group").find("button:contains('week')")[0];
    let monthBtn = $(".rbc-btn-group").find("button:contains('month')")[0];

    let todayBtn = $(".rbc-btn-group").find("button:contains('today')")[0];
    let prevBtn = $(".rbc-btn-group").find("button:contains('<')")[0];
    let nextBtn = $(".rbc-btn-group").find("button:contains('>')")[0];

    if (dayBtn && weekBtn && monthBtn) {
      //add event listeners
      $(dayBtn).on("click", function (e) {
        debugLog(`tampermonkey - clicked on day. Removing cloned calendar...`);
        setTimeout(() => {
          $(".rbc-month-view").remove();
        }, 1000);
      });
      $(weekBtn).on("click", function (e) {
        debugLog(`tampermonkey - clicked on week. Removing cloned calendar...`);
        setTimeout(() => {
          $(".rbc-month-view").remove();
        }, 1000);
      });
      $(monthBtn).on("click", function (e) {
        debugLog(
          `tampermonkey - clicked on month. Removing cloned calendar...`
        );
        setTimeout(() => {
          $(".rbc-time-content").remove();
        }, 1000);
      });
    }

    if (todayBtn && prevBtn && nextBtn) {
      //add event listeners
      $(todayBtn).on("click", function (e) {
        debugLog(
          `tampermonkey - clicked on today. Re-initializing calendar...`
        );
        copyComplete = 1;
        initCalendar(true);
      });
      $(prevBtn).on("click", function (e) {
        debugLog(`tampermonkey - clicked on prev. Re-initializing calendar...`);
        copyComplete = 1;
        initCalendar(true);
      });
      $(nextBtn).on("click", function (e) {
        debugLog(`tampermonkey - clicked on next. Re-initializing calendar...`);
        copyComplete = 1;
        initCalendar(true);
      });
    } else {
      debugLog(`tampermonkey waiting for add today, <, > button`);
      createTimeout(initCalendarHeaderBtns, 200);
    }
  }
}

let calendarInitialized = false;
function waitCalendar() {
  if (!calendarInitialized) {
    initCalendar();
    calendarInitialized = true;
  }
}

function waitAddAppointmentsBtn() {
  const $ = initJQuery();
  if (!$) {
    debugLog(`tampermonkey jquery not loaded`);
    createTimeout(waitAddAppointmentsBtn, 200);
    return;
  } else {
    initAddButton();
  }
}

function waitGoalTab() {
  //check to see if the care plan tab contents has loaded
  if (document.querySelector('[data-testid="goals-tab-btn"]')) {
    debugLog(`tampermonkey found goals tab`);
    document
      .querySelector('[data-testid="goals-tab-btn"]')
      .parentElement.remove();
  } else {
    //wait for content load
    debugLog(`tampermonkey waiting goals tab`);
    createTimeout(waitGoalTab, 200);
  }
}

function waitCarePlan() {
  const $ = initJQuery();
  if (!$) {
    debugLog(`tampermonkey waiting for jquery to load`);
    createTimeout(waitCarePlan, 200);
  } else {
    //check to see if the care plan tab contents has loaded
    const cpTabContents = $(".cp-tab-contents");
    if (cpTabContents.length > 0) {
      // handle edge case: clicking on careplan tab multiple times
      const careplanTabBtn = $('a[data-testid="careplans-tab-btn"]');
      careplanTabBtn.on("click", handleCarePlanTabClick);

      function handleCarePlanTabClick() {
        if (location.href.includes("all_plans")) {
          if (healthieAPIKey !== "") {
            cpTabContents && cpTabContents.empty();
          }
          waitCarePlan();
        }
      }
      const parent = cpTabContents.eq(0);
      // let's add a div with the text "Loading Careplan..."
      const loadingDiv = $("<div>")
        .addClass("vori-loading-message")
        .text("Loading Careplan...")
        .css({
          textAlign: "center",
          margin: "1.8rem",
          fontSize: "18px",
        });
      const loadingDivExists = $(".vori-loading-message");
      if (!loadingDivExists.length) {
        parent.append(loadingDiv);
      }
      patientNumber =
        location.href.split("/")[location.href.split("/").length - 2];
      let iframe = generateIframe(`${patientNumber}/${routeURLs.careplan}`, {
        className: "cp-tab-contents",
      });
      createTimeout(() => {
        parent.empty();
        parent.append(iframe);
      }, 50);
      carePlanLoopLock = carePlanLoopLock + 1;
      //remove styling of healthie tab element
      // document.getElementsByClassName("column is-12 is-12-mobile")[0].style = "";
    } else {
      //wait for content load
      debugLog(`tampermonkey waiting for careplan tab`);
      createTimeout(waitCarePlan, 200);
    }
  }
}

function rescheduleAppointment(appointmentID) {
  showOverlay(`${routeURLs.schedule}/${appointmentID}`, styles.scheduleOverlay);
}

function waitForMishaMessages() {
  window.onmessage = function (event) {
    debugLog("tampermonkey received misha event", event);
    //check event to see if is care plan message
    if (event.data.tmInput !== undefined && patientNumber !== "") {
      // let's get all user goals and delete them before adding new ones
      const getGoalQuery = `query {
                    goals(user_id: "${patientNumber}", per_page: 100) {
                      id,
                      name
                    }
                  }
                  `;
      const getGoalPayload = JSON.stringify({ query: getGoalQuery });
      healthieGQL(getGoalPayload).then((response) => {
        const allGoals = response.data.goals;
        debugLog("tampermonkey all goals", response);

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
          healthieGQL(deleteGoalPayload).then((response) => {
            debugLog("tampermonkey deleted goal", response);
          });
        });

        const carePlan = event.data.tmInput;
        debugLog(
          `tampermonkey message posted ${patientNumber} care plan status ${JSON.stringify(
            carePlan
          )}`
        );
        const goal = carePlan.goal.title;
        debugLog("tampermokey goal title ", goal);

        const milestones = carePlan.milestones;
        //create goal for each milestone
        milestones.forEach((element) => {
          debugLog("tampermonkey milestone inserted", element);
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
            healthieGQL(payload);
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
        healthieGQL(payload);

        const tasks = carePlan.tasks.tasks;
        debugLog("tampermonkey tasks are ", tasks);
        //create goal for each task
        tasks.forEach((element) => {
          debugLog("tampermonkey task is ", element);
          if (element.contentfulId == "6nJFhYE6FJcnWLc3r1KHPR") {
            //motion guide task
            debugLog("tampermonkey motion guide assigned");
            //create goal for each assigned exercise
            element.items[0].exercises.forEach((element) => {
              debugLog("tampermonkey", element);
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
              healthieGQL(payload);
            });
          } else {
            if (element.isVisible) {
              //regular task
              debugLog("tampermonkey regular task assigned");
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
              healthieGQL(payload);
            }
          }
        });
      });
    }
    if (
      event.data.reschedule !== undefined ||
      event.data.reload !== undefined
    ) {
      rescheduleAppointment(event.data.reschedule);
    }
    if (event.data.reload !== undefined) {
      window.location.reload();
    }
    if (event.data.closeWindow !== undefined) {
      hideOverlay();
    }
    if (event.data.patientProfile !== undefined) {
      debugLog(
        "tampermonkey navigating to patient profile",
        event.data.patientProfile
      );
      window.open(
        `https://${healthieURL}/users/${event.data.patientProfile}`,
        "_top"
      );
    }
    if (event.data.isEmailVerified !== undefined) {
      debugLog("tampermonkey is email verified", event.data.isEmailVerified);
      isEmailVerified = event.data.isEmailVerified;
      !isEmailVerified && verifyEmailPhoneButtons(true);
    }
    if (event.data.isPhoneNumberVerified !== undefined) {
      debugLog(
        "tampermonkey is phone verified",
        event.data.isPhoneNumberVerified
      );
      isPhoneNumberVerified = event.data.isPhoneNumberVerified;
      !isPhoneNumberVerified && verifyEmailPhoneButtons(false);
    }
    if (event.data.loading !== undefined) {
      debugLog("tampermonkey loading", event.data.loading);
      isLoadingEmailPhone = event.data.loading ? true : false;
    }
  };
}

function waitSettingsAPIpage() {
  //check to see if the care plan tab contents has loaded
  if (document.querySelector(".api_keys")) {
    debugLog(`tampermonkey found api keys section`);
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

    let storedApiKey = GM_getValue(
      isStagingEnv ? "healthieStagingApiKey" : "healthieApiKey",
      ""
    ); // Retrieve the stored API key using GM_getValue

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
        const patientNumber =
          location.href.split("/")[location.href.split("/").length - 2];
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
        healthieGQL(getGoalPayload).then((response) => {
          debugLog(
            `tampermonkey api key goals response: ${JSON.stringify(response)}`
          );

          if (response.errors) {
            alert(
              "That is not a valid API key. Please verify the key and try again."
            );
          } else {
            GM_setValue(
              isStagingEnv ? "healthieStagingApiKey" : "healthieApiKey",
              apiKey
            );
            alert("API key saved successfully!");
            createTimeout(null, 2000);
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
      apiMsgLink.textContent =
        "You have not connected your Healthie Account to Vori Health. Set it up here!";
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
    debugLog(`tampermonkey waiting for header`);
    createTimeout(isAPIconnected, 200);
  }
}

function showInstructions() {
  if (
    document.querySelector(".api-keys-wrapper") &&
    document.querySelector(".api-keys-input-button-wrapper")
  ) {
    const apiKeyInputContainer = document.querySelector(
      ".api-keys-input-button-wrapper"
    );

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

      apiKeyInputContainer.insertAdjacentElement("afterend", instructions);
    }
  } else {
    //wait for content load
    debugLog(`tampermonkey waiting to show instructions`);
    createTimeout(showInstructions, 200);
  }
}

function setGeneralTab() {
  let generalTab = document.querySelector('[data-testid="activetab-general"]');
  debugLog(`tampermonkey general tab is`, generalTab);
  generalTab &&
    generalTab.addEventListener(
      "click",
      function () {
        debugLog(`tampermonkey clicked general tab`, generalTab);
        waitAppointmentSidebar();
        createTimeout(function () {
          setAppointmentCollapse();
        }, 600);
      },
      false
    );
}

function setAppointmentCollapse() {
  let appointmentSectionTitle = document.querySelector(
    '[data-testid="cp-section-appointments"]'
  );
  appointmentSectionTitle &&
    appointmentSectionTitle.addEventListener(
      "click",
      function () {
        debugLog(
          `tampermonkey clicked section title`,
          appointmentSectionTitle.className
        );
        appointmentSectionTitle.className !=
          "cp-sidebar-expandable-section undefined opened" &&
          waitAppointmentSidebar();
      },
      false
    );
}

function waitInfo() {
  let infoButton = document.getElementsByClassName(
    "right-menu-trigger is-hidden-mobile"
  )[0];
  if (infoButton) {
    createTimeout(function () {
      setGeneralTab();
      setAppointmentCollapse();
    }, 600);
    infoButton.addEventListener(
      "click",
      function () {
        createTimeout(function () {
          let appointmentWindow = document.querySelector(
            '[data-testid="cp-section-appointments"]'
          );
          debugLog(`tampermonkey info clicked`, appointmentWindow);
          setGeneralTab();
          setAppointmentCollapse();
          appointmentWindow && waitAppointmentSidebar();
        }, 500);
      },
      false
    );
  } else {
    createTimeout(waitInfo, 500);
  }
}

function waitAppointmentSidebar() {
  let appointmentWindow = document.querySelector(
    '[data-testid="cp-section-appointments"]'
  );
  let goalsTab = document.querySelector('[data-testid="tab-goals"]');
  debugLog(`tampermonkey goals tab `, goalsTab);
  goalsTab && goalsTab.remove();
  let actionLinks = Array.from(
    document.getElementsByClassName("healthie-action-link")
  );
  if (appointmentWindow && actionLinks[0]) {
    goalsTab && goalsTab.remove();
    actionLinks.forEach((element) => {
      debugLog("tampermonkey action link found", element);
      element.remove();
    });
  } else {
    //wait for content load
    debugLog(`tampermonkey waiting to hide chat links`);
    createTimeout(waitAppointmentSidebar, 500);
  }
}

function waitClientList() {
  const $ = initJQuery();
  let bookLinks = Array.from(document.querySelectorAll("button")).filter(
    (e) => e.textContent === "Book Session"
  );
  debugLog(`tampermonkey waiting to update book link`, bookLinks);
  if (bookLinks.length > 0) {
    Array.from(bookLinks).forEach((element) => {
      debugLog("tampermonkey book link found", element);
      let ID = element.parentElement
        .getAttribute("data-testid")
        .split("-")
        .at(-1);
      let bookButton = $(element);
      let clonedButton = bookButton.clone(true);
      clonedButton.on("click", function (e) {
        e.stopPropagation();
        //schedule/patientid
        showOverlay(`${routeURLs.schedule}/${ID}`, styles.scheduleOverlay);
      });
      bookButton.replaceWith(clonedButton);
    });
    createTimeout(waitClientList, 500);
  } else {
    //wait for content load
    debugLog(`tampermonkey waiting to update book link`);
    createTimeout(waitClientList, 500);
  }
}

function healthieGQL(payload) {
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
      debugLog("tampermonkey", result);
      return result;
    });

  return response;
}

function addMembershipAndOnboarding() {
  //get phone icon and related column
  const phoneColumn = document.querySelector(
    ".col-12.col-sm-6:has(.telephone-icon)"
  );
  const iframeAdded = phoneColumn
    ? phoneColumn.parentNode.querySelector(".misha-iframe-container")
    : null;

  if (phoneColumn && !iframeAdded) {
    // get the patient number from the URL
    patientNumber = location.href.split("/")[4];
    debugLog(`tampermonkey patient number`, patientNumber);
    // create iframe (generateIframe returns a jQuery object)
    //Add custom height and width to avoid scrollbars because the material ui Select component
    const iframe = generateIframe(
      `${routeURLs.patientStatus}/${patientNumber}`,
      { height: "190px", width: "400px" }
    );
    const iframeExists = phoneColumn.parentNode.querySelector(
      ".misha-iframe-container"
    );
    // add iframe after phone element, get the native DOM Node from the jQuery object, this is the first array element.
    !iframeExists &&
      phoneColumn.parentNode.insertBefore(iframe[0], phoneColumn.nextSibling);
  } else {
    createTimeout(() => {
      addMembershipAndOnboarding();
    }, 200);
  }
}

function verifyEmailPhone() {
  debugLog(`tampermonkey verifyEmailPhone`);
  let clientInfoPane = document.getElementsByClassName("client-info-pane");
  if (clientInfoPane.length > 0) {
    debugLog(`tampermonkey found client info pane`);
    let saveButton = document.getElementsByClassName(
      "client-profile-submit-button healthie-button primary-button small-button float-right"
    );
    debugLog(`tampermonkey save button`, saveButton);
    if (saveButton.length > 0) {
      debugLog(`tampermonkey found save button`, saveButton);
      saveButton[0].onclick = function () {
        createTimeout(() => {
          window.location.reload();
        }, 1000);
      };
    }
    let clientInfoPaneObj = clientInfoPane[0];
    //load invisible iframe for getPatientInfo to determine verification status of phone/email
    patientNumber =
      location.href.split("/")[location.href.split("/").length - 2];
    let iframe = generateIframe(`getPatientInfo?id=${patientNumber}`, {
      position: "absolute",
      height: "0px",
      width: "0px",
      border: "0px",
    });
    // append to document body
    $(clientInfoPaneObj).append(iframe);
  } else {
    createTimeout(() => {
      verifyEmailPhone();
    }, 200);
  }
}

function verifyEmailPhoneButtons(isEmail) {
  let field = isEmail ? document.getElementById("email"): document.getElementById("phone_number");
  let button = isEmail ? document.getElementById("verify-email-button"): document.getElementById("verify-phone-button");
  if(field.value != ''){
    patientNumber =
      location.href.split("/")[location.href.split("/").length - 2];
    let verifyOverlayURL = routeURLs.otpVerify + `?id=${patientNumber}`;
    verifyOverlayURL += isEmail ? `&email=${encodeURIComponent(field.value)}` : `&phone=${encodeURIComponent(field.value)}`;
    if(!button && field){
      const buttonStyle = {
        background: "#026460",
        color: "white",
        borderRadius: "2px",
      };
      const buttonStyleString = Object.entries(buttonStyle)
        .map(
          ([property, value]) => `${convertToCSSProperty(property)}: ${value};`
        )
        .join(" ");
      const button = $("<button>", {
        id: isEmail ? "verify-email-button" : "verify-phone-button",
        text: "Verify",
        style: buttonStyleString,
        type: "button",
        click: function () {
          showOverlay(verifyOverlayURL, styles.otpOverlay);
        },
      });
      field.parentNode.insertBefore(button[0], field.nextSibling);
      let containerStyle = field.parentElement.style;
      containerStyle.display = "flex";
      containerStyle.flexDirection = "row";
    }
  }
}

function observeDOMChanges(mutations, observer) {
  // handle url changes
  if (location.href !== previousUrl) {
    previousUrl = location.href;
    //reset loop flag
    carePlanLoopLock = 0;
    debugLog(`tampermonkey URL changed to ${location.href}`);

    // Clear all timeouts
    for (let i = 0; i < timeoutIds.length; i++) {
      //debugLog(`tampermonkey clear timeout ${timeoutIds[i]}`);
      clearTimeout(timeoutIds[i]);
    }
    timeoutIds = [];

    waitForMishaMessages();

    //Care plans URL
    //if (location.href.includes("/all_plans")) {
    if (urlValidation.carePlan.test(location.href)) {
      //Function that will check when care plan tab has loaded
      debugLog("tampermonkey calls waitCarePlan");
      waitCarePlan();
    }

    if (urlValidation.goals.test(location.href)) {
      //Function that will check when goal tab has loaded
      debugLog("tampermonkey calls waitGoalTab");
      waitGoalTab();
    }

    if (urlValidation.appointmentsProfile.test(location.href)) {
      debugLog(
        "tampermonkey calls waitAppointmentsProfile and addMembershipAndOnboarding"
      );
      waitAppointmentsProfile();
    }

    if (urlValidation.membership.test(location.href)) {
      addMembershipAndOnboarding();
    }

    if (urlValidation.verifyEmailPhone.test(location.href)) {
      verifyEmailPhone();
    }

    if (urlValidation.apiKeys.test(location.href)) {
      //Function to handle api keys
      debugLog("tampermonkey calls waitSettingsAPIpage and  showInstructions");
      waitSettingsAPIpage();
      showInstructions();
    }

    if (urlValidation.appointments.test(location.href)) {
      //"/appointments" ||/organization ||/providers/
      debugLog("tampermonkey calls waitAddAppointmentsBtn and waitCalendar");
      waitAddAppointmentsBtn(); //Function to handle clicking the Add appointments button
      waitCalendar(); //Function to handle clicking on empty appointment slots
    }

    if (urlValidation.appointmentsHome.test(location.href)) {
      debugLog("tampermonkey calls waitAppointmentsHome");
      waitAppointmentsHome();
    }

    if (urlValidation.conversations.test(location.href)) {
      debugLog("tampermonkey calls waitAppointmentSidebar and waitInfo");
      waitAppointmentSidebar();
      waitInfo();
    }
    if (urlValidation.clientList.test(location.href)) {
      debugLog("tampermonkey calls waitClientList");
      waitClientList();
      waitForAddPatientButton();
    }
    isAPIconnected();
  } else {
    //debugLog(`tampermonkey debug  else`);
    //if (location.href.includes("/all_plans")) {
    //carePlanLoopLock avoids triggering infinite loop
    if (carePlanLoopLock > 1 && location.href.includes("all_plans")) {
      var iframe = document.querySelector("#MishaFrame.cp-tab-contents");
      //check if Iframe doesn't exists
      if (!iframe) {
        //debugLog("tampermonkey debug The iframe does not exist");
        //reset loop flag
        carePlanLoopLock = 0;
        //Checks if goals tab exists (with a different id) and removes it.
        let goalsTab = document.querySelector('[data-testid="goals-tab-btn"]');
        debugLog(`tampermonkey goals tab `, goalsTab);
        if (goalsTab) {
          let parentDiv = goalsTab.closest("div");
          if (parentDiv) {
            parentDiv.remove();
          }
        }
        waitCarePlan();
      }
    }
  }

  // The rest
  const calendarTargetClasses = ["rbc-time-content", "rbc-month-view"];
  const homeTargetClasses = ["provider-home-content"];
  const basicInfoTargetClasses = ["cp-sidebar-expandable-section"];

  for (const mutation of mutations) {
    const { target, addedNodes, removedNodes } = mutation;

    // Check if the mutation target or any added/removed node has one of the target classes or if the children of these classes have changed
    if (
      (target &&
        calendarTargetClasses.some((className) =>
          target.classList.contains(className)
        )) ||
      (addedNodes &&
        [...addedNodes].some(
          (addedNode) =>
            addedNode.nodeType === Node.ELEMENT_NODE &&
            calendarTargetClasses.some((className) =>
              addedNode.classList.contains(className)
            )
        )) ||
      (removedNodes &&
        [...removedNodes].some(
          (removedNode) =>
            removedNode.nodeType === Node.ELEMENT_NODE &&
            calendarTargetClasses.some((className) =>
              removedNode.classList.contains(className)
            )
        )) ||
      (addedNodes &&
        [...addedNodes].some(
          (addedNode) =>
            addedNode.nodeType === Node.ELEMENT_NODE &&
            calendarTargetClasses.some((className) =>
              addedNode.querySelector(`.${className}`)
            )
        )) ||
      (removedNodes &&
        [...removedNodes].some(
          (removedNode) =>
            removedNode.nodeType === Node.ELEMENT_NODE &&
            calendarTargetClasses.some((className) =>
              removedNode.querySelector(`.${className}`)
            )
        ))
    ) {
      observer.disconnect();
      let clonedCalendar = document.querySelector(".cloned-calendar");
      !clonedCalendar && copyComplete++;
      debugLog(`increased copy complete in observer`, copyComplete);
      initCalendar();
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      break;
    }

    if (
      (target &&
        homeTargetClasses.some((className) =>
          target.classList.contains(className)
        )) ||
      (addedNodes &&
        [...addedNodes].some(
          (addedNode) =>
            addedNode.nodeType === Node.ELEMENT_NODE &&
            homeTargetClasses.some((className) =>
              addedNode.classList.contains(className)
            )
        ))
    ) {
      observer.disconnect();
      waitAppointmentsHome();
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      break;
    }

    if (
      (target &&
        basicInfoTargetClasses.some((className) =>
          target.classList.contains(className)
        )) ||
      (addedNodes &&
        [...addedNodes].some(
          (addedNode) =>
            addedNode.nodeType === Node.ELEMENT_NODE &&
            basicInfoTargetClasses.some((className) =>
              addedNode.classList.contains(className)
            )
        ))
    ) {
      observer.disconnect();
      addMembershipAndOnboarding();
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      break;
    }
  }
}

//observe changes to the DOM, check for URL changes
const config = { subtree: true, childList: true };
const observer = new MutationObserver(observeDOMChanges);
observer.observe(document, config);
=======
// ==UserScript==
// @name         Healthie Care Plan Integration
// @namespace    http://tampermonkey.net/
// @version      0.74
// @description  Injecting care plan components into Healthie
// @author       Don, Tonye, Alejandro
// @match        https://vorihealth.gethealthie.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=vori.health
// @sandbox      JavaScript
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

/*
 * ATTENTION: The "eval" devtool has been used (maybe by default in mode: "development").
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ "./api/index.ts":
/*!**********************!*\
  !*** ./api/index.ts ***!
  \**********************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   healthieGQL: () => (/* binding */ healthieGQL),\n/* harmony export */   isAPIconnected: () => (/* binding */ isAPIconnected),\n/* harmony export */   waitSettingsAPIpage: () => (/* binding */ waitSettingsAPIpage)\n/* harmony export */ });\n/* harmony import */ var _utils_index__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../utils/index */ \"./utils/index.ts\");\n/* harmony import */ var _helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../helpers/timeoutHelpers */ \"./helpers/timeoutHelpers.ts\");\n/* harmony import */ var _helpers_ui_index__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ../helpers/ui/index */ \"./helpers/ui/index.ts\");\n\n\n\nvar isStagingEnv = location.href.includes(\"securestaging\") ? true : false;\nvar healthieAPIKey = GM_getValue(isStagingEnv ? \"healthieStagingApiKey\" : \"healthieApiKey\", \"\");\nvar auth = \"Basic \".concat(healthieAPIKey);\nfunction healthieGQL(payload) {\n    var api_env = isStagingEnv ? \"staging-api\" : \"api\";\n    var response = fetch(\"https://\" + api_env + \".gethealthie.com/graphql\", {\n        method: \"POST\",\n        headers: {\n            AuthorizationSource: \"API\",\n            Authorization: auth,\n            \"content-type\": \"application/json\",\n        },\n        body: payload,\n    })\n        .then(function (res) { return res.json(); })\n        .then(function (result) {\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey\", result);\n        return result;\n    });\n    return response;\n}\nfunction isAPIconnected() {\n    // Check to see if the header has loaded\n    var header = document.querySelector(\".header\");\n    if (header) {\n        var voriHeaderExists = document.querySelector(\".vori-api-message\");\n        if (!voriHeaderExists) {\n            var apiMsgDiv = document.createElement(\"div\");\n            apiMsgDiv.classList.add(\"vori-api-message\");\n            apiMsgDiv.style.display = \"block\";\n            apiMsgDiv.style.position = \"relative\";\n            apiMsgDiv.style.background = \"#e3e532\";\n            apiMsgDiv.style.top = \"60px\";\n            apiMsgDiv.style.minHeight = \"42px\";\n            apiMsgDiv.style.textAlign = \"center\";\n            apiMsgDiv.style.padding = \"10px\";\n            var apiMsgLink_1 = document.createElement(\"a\");\n            apiMsgLink_1.textContent = \"You have not connected your Healthie Account to Vori Health. Set it up here!\";\n            apiMsgLink_1.href = \"/settings/api_keys\";\n            apiMsgLink_1.style.color = \"#333\";\n            apiMsgLink_1.style.fontSize = \"15px\";\n            apiMsgLink_1.style.letterSpacing = \"0.3px\";\n            apiMsgLink_1.style.textDecoration = \"none\";\n            apiMsgLink_1.addEventListener(\"mouseover\", function () { return (0,_helpers_ui_index__WEBPACK_IMPORTED_MODULE_2__.addHoverEffect)(apiMsgLink_1); });\n            apiMsgLink_1.addEventListener(\"mouseout\", function () { return (0,_helpers_ui_index__WEBPACK_IMPORTED_MODULE_2__.removeHoverEffect)(apiMsgLink_1); });\n            apiMsgDiv.appendChild(apiMsgLink_1);\n            if (healthieAPIKey === \"\") {\n                apiMsgDiv.style.display = \"block\";\n            }\n            else {\n                apiMsgDiv.style.display = \"none\";\n            }\n            header.insertAdjacentElement(\"afterend\", apiMsgDiv);\n        }\n    }\n    else {\n        // Wait for content load\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey waiting for header\");\n        (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(isAPIconnected, 200);\n    }\n}\nfunction waitSettingsAPIpage() {\n    //check to see if the care plan tab contents has loaded\n    if (document.querySelector(\".api_keys\")) {\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey found api keys section\");\n        // Check if the api-keys-wrapper already exists\n        var existingWrapper = document.querySelector(\".api-keys-wrapper.vori\");\n        var newButton = void 0;\n        var newInput_1;\n        if (!existingWrapper) {\n            // Create the new elements\n            var newWrapper = document.createElement(\"div\");\n            newWrapper.classList.add(\"api-keys-wrapper\", \"vori\");\n            newWrapper.style.marginTop = \"2rem\";\n            newWrapper.style.paddingBottom = \"2rem\";\n            newWrapper.style.borderBottom = \"1px solid #e0e0e0\";\n            newWrapper.style.marginRight = \"28px\";\n            var newHeader = document.createElement(\"div\");\n            newHeader.classList.add(\"api-keys-header\");\n            newHeader.textContent = \"Connect to Vori Health\";\n            newHeader.style.height = \"44px\";\n            newHeader.style.color = \"#16284a\";\n            newHeader.style.fontFamily = '\"Avenir\",Helvetica,\"Arial\",sans-serif';\n            newHeader.style.fontWeight = \"800\";\n            newHeader.style.fontSize = \"28px\";\n            newHeader.style.lineHeight = \"34px\";\n            newHeader.style.letterSpacing = \"-.02em\";\n            var inputButtonWrapper = document.createElement(\"div\");\n            inputButtonWrapper.classList.add(\"api-keys-input-button-wrapper\");\n            inputButtonWrapper.style.display = \"flex\";\n            inputButtonWrapper.style.justifyContent = \"space-between\";\n            inputButtonWrapper.style.width = \"100%\";\n            newInput_1 = document.createElement(\"input\");\n            newInput_1.setAttribute(\"type\", \"text\");\n            newInput_1.setAttribute(\"placeholder\", \"Enter your API key here\");\n            newInput_1.classList.add(\"api-key-input\");\n            newInput_1.style.height = \"38px\";\n            newInput_1.style.width = \"100%\";\n            newInput_1.style.maxWidth = \"292px\";\n            newInput_1.style.padding = \"0 14px\";\n            newInput_1.style.borderRadius = \"4px\";\n            newInput_1.style.border = \"1px solid #828282\";\n            newButton = document.createElement(\"button\");\n            newButton.setAttribute(\"type\", \"button\");\n            newButton.textContent = \"Link API key\";\n            newButton.style.backgroundColor = \"#4a90e2\";\n            newButton.style.color = \"#fff\";\n            newButton.style.border = \"1px solid #4a90e2\";\n            newButton.style.padding = \"8px 10px\";\n            newButton.style.fontFamily = '\"Avenir\",Helvetica,\"Arial\",sans-serif';\n            newButton.style.fontSize = \"14px\";\n            newButton.style.lineHeight = \"20px\";\n            newButton.style.width = \"200px\";\n            newButton.style.borderRadius = \"3px\";\n            newButton.style.cursor = \"pointer\";\n            // Append the new elements to the existing container\n            var mainContainer = document.querySelector(\".main-settings__container\");\n            if (mainContainer) {\n                mainContainer.appendChild(newWrapper);\n            }\n            else {\n                console.error(\"Main container not found\");\n                // Handle the error case appropriately\n            }\n            // Append the new elements to the new wrapper\n            newWrapper.appendChild(newHeader);\n            newWrapper.appendChild(inputButtonWrapper);\n            inputButtonWrapper.appendChild(newInput_1);\n            inputButtonWrapper.appendChild(newButton);\n        }\n        else {\n            newButton = existingWrapper.querySelector(\"button\");\n            newInput_1 = existingWrapper.querySelector(\"input\");\n        }\n        var storedApiKey = GM_getValue(isStagingEnv ? \"healthieStagingApiKey\" : \"healthieApiKey\", \"\"); // Retrieve the stored API key using GM_getValue\n        if (storedApiKey === \"\") {\n            newInput_1.value = storedApiKey; // Set the initial value of the input\n        }\n        else {\n            newInput_1.value = \"***************\"; // show mask indicating that a valid key is stored\n        }\n        // Add onclick handler to the \"Link Api key\" button\n        newButton.onclick = function () {\n            var apiKey = newInput_1.value.trim(); // Trim whitespace from the input value\n            if (apiKey === \"\") {\n                alert(\"Please enter a valid API key!\");\n            }\n            else {\n                var patientNumber = location.href.split(\"/\")[location.href.split(\"/\").length - 2];\n                healthieAPIKey = apiKey;\n                auth = \"Basic \".concat(healthieAPIKey);\n                // let's check that we can get goals successfully\n                var getGoalQuery = \"query {\\n            goals {\\n              id\\n              name\\n            }\\n          }\\n          \";\n                var getGoalPayload = JSON.stringify({ query: getGoalQuery });\n                healthieGQL(getGoalPayload).then(function (response) {\n                    (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey api key goals response: \".concat(JSON.stringify(response)));\n                    if (response.errors) {\n                        alert(\"That is not a valid API key. Please verify the key and try again.\");\n                    }\n                    else {\n                        GM_setValue(isStagingEnv ? \"healthieStagingApiKey\" : \"healthieApiKey\", apiKey);\n                        alert(\"API key saved successfully!\");\n                        (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(function () {\n                            window.location.reload();\n                        }, 2000);\n                        window.location.reload();\n                    }\n                });\n            }\n        };\n    }\n    else {\n        //wait for content load\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey waiting for api keys section\");\n        (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(waitSettingsAPIpage, 200);\n    }\n}\n\n\n\n//# sourceURL=webpack://typescript-script/./api/index.ts?");

/***/ }),

/***/ "./helpers/calendar/index.ts":
/*!***********************************!*\
  !*** ./helpers/calendar/index.ts ***!
  \***********************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   initCalendar: () => (/* binding */ initCalendar),\n/* harmony export */   initCalendarHeaderBtns: () => (/* binding */ initCalendarHeaderBtns),\n/* harmony export */   initSidebarCalendar: () => (/* binding */ initSidebarCalendar),\n/* harmony export */   setAppointmentCollapse: () => (/* binding */ setAppointmentCollapse),\n/* harmony export */   showBothCalendars: () => (/* binding */ showBothCalendars),\n/* harmony export */   waitCalendar: () => (/* binding */ waitCalendar)\n/* harmony export */ });\n/* harmony import */ var _utils_index__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../../utils/index */ \"./utils/index.ts\");\n/* harmony import */ var _init_index__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../../init/index */ \"./init/index.ts\");\n/* harmony import */ var _helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ../../helpers/timeoutHelpers */ \"./helpers/timeoutHelpers.ts\");\n/* harmony import */ var _helpers_ui_index__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! ../../helpers/ui/index */ \"./helpers/ui/index.ts\");\n\n\n\n\nvar maxWaitForEvents = 500; // comically high number to prevent infinite loop\nvar maxWaitForInit = 500; // comically high number to prevent infinite loop\nvar maxWaitForCalendarLoad = 1500; // comically high number to prevent infinite loop\nvar initCalTimeout = null;\nvar copyComplete = -1;\nvar delayedRun = 0;\nvar debug = false;\nvar routeURLs = {\n    schedule: \"schedule\",\n    careplan: \"careplan\",\n    goals: \"app/schedule\",\n    appointment: \"appointment\",\n    appointments: \"appointments\",\n    patientStatus: \"patientStatusStandalone\",\n    providerSchedule: \"provider-schedule\",\n    otpVerify: \"otpVerifyStandalone\",\n    createPatientDialog: \"createPatientDialog\",\n};\nvar styles = {\n    scheduleOverlay: {\n        display: \"inline-block\",\n        background: \"rgb(255, 255, 255)\",\n        maxWidth: \"90vw\", // fallback for browsers that don't support svw\n        width: \"100vw\",\n        height: \"90vh\", // fallback for browsers that don't support svh\n        overflow: \"hidden\",\n    },\n    patientDialogOverlay: {\n        display: \"inline-block\",\n        background: \"rgb(255, 255, 255)\",\n        maxWidth: \"30vw\", // fallback for browsers that don't support svw\n        width: \"30vw\",\n        height: \"80vh\", // fallback for browsers that don't support svh\n        overflow: \"hidden\",\n    },\n    appointmentDetailsOverlay: {\n        height: \"350px\",\n        width: \"100%\",\n        overflow: \"hidden\",\n    },\n    otpOverlay: {\n        width: \"500px\",\n        height: \"500px\",\n    },\n};\nfunction initCalendar(replaceCalendar) {\n    var $ = (0,_init_index__WEBPACK_IMPORTED_MODULE_1__.initJQuery)();\n    if (!$) {\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"Tampermonkey jQuery not loaded\");\n        initCalTimeout = (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_2__.createTimeout)(function () {\n            initCalendar(replaceCalendar);\n        }, 200);\n        return;\n    }\n    else {\n        if (initCalTimeout !== null) {\n            (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_2__.clearMyTimeout)(initCalTimeout);\n        }\n        // clear jquery timeout\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"Tampermonkey initializing calendar. maxWait: [\".concat(maxWaitForInit, \", \").concat(maxWaitForCalendarLoad, \"], delayedRun: \").concat(delayedRun, \", replaceCalendar: \").concat(replaceCalendar));\n        maxWaitForInit--;\n        maxWaitForCalendarLoad--;\n        if (maxWaitForInit < 0 || maxWaitForCalendarLoad < 0) {\n            window.location.reload();\n            return;\n        }\n        maxWaitForInit = 500;\n        var calendar = null;\n        var calendarHeaderBtns = $(\".rbc-btn-group\");\n        var activeBtn = calendarHeaderBtns.find(\".rbc-active\");\n        var activeTab = $(\".calendar-tabs\").find(\".tab-item.active\");\n        var calendarTab = activeTab && activeTab.text().toLowerCase().includes(\"calendar\");\n        var availabilitiesTab = activeTab && activeTab.text().toLowerCase().includes(\"availability\");\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"Tampermonkey copyComplete\", copyComplete);\n        // Check if we're on availabilities tab, or if  calendar is loaded and cloned\n        if (availabilitiesTab ||\n            (!replaceCalendar && $(\".main-calendar-column\").find(\".cloned-calendar\").length > 0) ||\n            copyComplete > 500 ||\n            copyComplete < 0) {\n            return;\n        }\n        if (replaceCalendar) {\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"Tampermonkey force re-init calendar\");\n            $(\".cloned-calendar\").remove(); // remove all instances of existing cloned calendar\n        }\n        // First overlay a transparent div on top of the calendar until cloning is done\n        var overlay = $(\"<div>\").addClass(\"overlay-vori\").css({\n            position: \"absolute\",\n            display: \"block\",\n            inset: \"0px\",\n            zIndex: \"9999999\",\n            background: \"ffffff00\",\n            backdropFilter: \"blur(5px)\",\n            pointerEvents: \"none\",\n            userSelect: \"none\",\n        });\n        // First init add button to make sure event gets overwritten\n        (0,_init_index__WEBPACK_IMPORTED_MODULE_1__.initAddButton)();\n        initCalendarHeaderBtns();\n        // check if calendar is loading\n        var calendarLoading = $(\".day-view.is-loading, .week-view.is-loading, .month-view.is-loading\");\n        if (calendarLoading.length > 0) {\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"Tampermonkey waiting for calendar to load\");\n            if ($(\".main-calendar-column\").find(\".overlay-vori\").length > 0) {\n                $(\".main-calendar-column\").css({ position: \"relative\" }).append(overlay);\n                (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"Tampermonkey added overlay to calendar\");\n            }\n            initCalTimeout = (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_2__.createTimeout)(function () {\n                initCalendar(replaceCalendar);\n            }, 1000);\n            return;\n        }\n        else {\n            maxWaitForCalendarLoad = 1500;\n            $(\".overlay-vori\").remove();\n        }\n        // wait 1 second then proceed to clone calendar\n        delayedRun++;\n        (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_2__.createTimeout)(function () {\n            initCalendar(replaceCalendar);\n            copyComplete++;\n        }, 1000);\n        var cssRules = \"\\n           .rbc-calendar {\\n             position: relative;\\n           }\\n           .cloned-calendar {\\n             position: absolute;\\n             top: 64px;\\n             width: 100.8%;\\n             background: #fff;\\n           }\\n           .cloned-calendar.rbc-month-view {\\n             top: 60px;\\n           }\\n         \";\n        var cssRuleToCheck_1 = \".cloned-calendar\";\n        var styleElementExists = $(\"style\").filter(function () {\n            return $(this).text().indexOf(cssRuleToCheck_1) !== -1;\n        }).length > 0;\n        if (!styleElementExists) {\n            var styleElement = document.createElement(\"style\");\n            styleElement.appendChild(document.createTextNode(cssRules));\n            $(\"head\").append(styleElement);\n        }\n        if (calendarTab) {\n            initSidebarCalendar();\n            if (activeBtn && (activeBtn.text().toLowerCase().includes(\"day\") || activeBtn.text().toLowerCase().includes(\"week\")) && copyComplete > 0) {\n                (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"Tampermonkey calendar is on day or week view\");\n                calendar = $(\".rbc-time-content\");\n                var ogCalendar = calendar && calendar.first().addClass(\"og-calendar\");\n                var clonedCalendar = ogCalendar.clone(true);\n                clonedCalendar.addClass(\"cloned-calendar\").removeClass(\"og-calendar\").removeAttr(\"style\");\n                // debug mode - set to True for quick debugging\n                debug && showBothCalendars(clonedCalendar, ogCalendar);\n                // instead of replacing the original calendar, we'll hide it, and append the cloned calendar\n                !debug &&\n                    ogCalendar.css({\n                        display: \"none\",\n                        position: \"absolute\",\n                        transform: \"translateX(68%)\",\n                    });\n                ogCalendar.parent().append(clonedCalendar);\n                (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"Tampermonkey hid original calendar and appended cloned calendar - day/week view\");\n            }\n            else if (activeBtn && activeBtn.text().toLowerCase().includes(\"month\") && copyComplete > 0) {\n                (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"Tampermonkey calendar is on month view\");\n                calendar = $(\".rbc-month-view\");\n                var ogCalendar = calendar && calendar.first().addClass(\"og-calendar\");\n                if (ogCalendar.length > 0) {\n                    var clonedCalendar = ogCalendar.clone(true);\n                    var monthView = clonedCalendar[0].childNodes;\n                    var children = Array.from(monthView);\n                    children.forEach(function (child) {\n                        // Check if the child is an HTMLElement before cloning\n                        if (child instanceof HTMLElement) {\n                            // Clone the HTMLElement\n                            var clone = $(child).clone();\n                            clone.addClass(\"cloned\");\n                            $(child).replaceWith(clone);\n                        }\n                    });\n                    clonedCalendar.addClass(\"cloned-calendar\").removeClass(\"og-calendar\").removeAttr(\"style\");\n                    debug && showBothCalendars(clonedCalendar, ogCalendar);\n                    !debug &&\n                        ogCalendar.css({\n                            display: \"none\",\n                            position: \"absolute\",\n                            transform: \"translateX(68%)\",\n                        });\n                    ogCalendar.parent().append(clonedCalendar);\n                    (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"Tampermonkey hid original calendar and appended cloned calendar - day/week view\");\n                }\n            }\n        }\n        if (calendar) {\n            maxWaitForEvents = 500;\n            // Event listeners\n            $(\".rbc-time-slot, .rbc-day-bg\").on(\"click\", function (e) {\n                e.stopPropagation();\n                (0,_helpers_ui_index__WEBPACK_IMPORTED_MODULE_3__.showOverlay)(\"\".concat(routeURLs.schedule), styles.scheduleOverlay);\n            });\n            $(\".rbc-event.calendar-event\").on(\"click\", function (e) {\n                e.stopPropagation();\n                var dataForValue = $(this).attr(\"data-for\");\n                if (dataForValue) {\n                    var apptUuid = dataForValue.split(\"__\")[1].split(\"_\")[0];\n                    //appointment/appointment id\n                    (0,_helpers_ui_index__WEBPACK_IMPORTED_MODULE_3__.showOverlay)(\"\".concat(routeURLs.appointment, \"/\").concat(apptUuid), styles.appointmentDetailsOverlay);\n                }\n            });\n            $(\".cloned-calendar\") && (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"Tampermonkey calendar cloned\");\n            copyComplete = -1;\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"reset copy complete in initCalendar after cloning\", copyComplete);\n            var clonedCalendar = $(\".cloned-calendar\");\n            if (clonedCalendar && initCalTimeout !== null) {\n                (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_2__.clearMyTimeout)(initCalTimeout);\n            }\n            $(\".overlay-vori\").remove();\n        }\n        else {\n            maxWaitForEvents--;\n            if (maxWaitForEvents === 0) {\n                window.location.reload();\n            }\n            else {\n                (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"Tampermonkey waiting for calendar and events\");\n                (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_2__.createTimeout)(function () {\n                    initCalendar(replaceCalendar);\n                }, 1000);\n            }\n        }\n    }\n}\nfunction initCalendarHeaderBtns() {\n    var $ = (0,_init_index__WEBPACK_IMPORTED_MODULE_1__.initJQuery)();\n    if (!$) {\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey waiting for jquery to load\");\n        (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_2__.createTimeout)(function () {\n            (0,_helpers_ui_index__WEBPACK_IMPORTED_MODULE_3__.showOverlay)(\"dummy-url\", {}); // To do\n        }, 200);\n        return;\n    }\n    else {\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey calendar initializing today, prev, next buttons\");\n        var activeTab = $(\".calendar-tabs\").find(\".tab-item.active\");\n        var availabilitiesTab = activeTab && activeTab.text().toLowerCase().includes(\"availability\");\n        if (availabilitiesTab) {\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"Tampermonkey calendar is on availability tab - nothing to do here\");\n            return;\n        }\n        var dayBtn = $(\".rbc-btn-group\").find(\"button:contains('day')\")[0];\n        var weekBtn = $(\".rbc-btn-group\").find(\"button:contains('week')\")[0];\n        var monthBtn = $(\".rbc-btn-group\").find(\"button:contains('month')\")[0];\n        var todayBtn = $(\".rbc-btn-group\").find(\"button:contains('today')\")[0];\n        var prevBtn = $(\".rbc-btn-group\").find(\"button:contains('<')\")[0];\n        var nextBtn = $(\".rbc-btn-group\").find(\"button:contains('>')\")[0];\n        if (dayBtn && weekBtn && monthBtn) {\n            //add event listeners\n            $(dayBtn).on(\"click\", function (e) {\n                (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey - clicked on day. Removing cloned calendar...\");\n                setTimeout(function () {\n                    $(\".rbc-month-view\").remove();\n                }, 1000);\n            });\n            $(weekBtn).on(\"click\", function (e) {\n                (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey - clicked on week. Removing cloned calendar...\");\n                setTimeout(function () {\n                    $(\".rbc-month-view\").remove();\n                }, 1000);\n            });\n            $(monthBtn).on(\"click\", function (e) {\n                (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey - clicked on month. Removing cloned calendar...\");\n                setTimeout(function () {\n                    $(\".rbc-time-content\").remove();\n                }, 1000);\n            });\n        }\n        if (todayBtn && prevBtn && nextBtn) {\n            //add event listeners\n            $(todayBtn).on(\"click\", function (e) {\n                (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey - clicked on today. Re-initializing calendar...\");\n                copyComplete = 1;\n                initCalendar(true);\n            });\n            $(prevBtn).on(\"click\", function (e) {\n                (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey - clicked on prev. Re-initializing calendar...\");\n                copyComplete = 1;\n                initCalendar(true);\n            });\n            $(nextBtn).on(\"click\", function (e) {\n                (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey - clicked on next. Re-initializing calendar...\");\n                copyComplete = 1;\n                initCalendar(true);\n            });\n        }\n        else {\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey waiting for add today, <, > button\");\n            (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_2__.createTimeout)(initCalendarHeaderBtns, 200);\n        }\n    }\n}\nfunction showBothCalendars(clonedCalendar, ogCalendar) {\n    clonedCalendar.css({\n        position: \"absolute\",\n        transform: \"translate(-46%, 35px)\",\n        left: \"0px\",\n        width: \"67%\",\n        maxWidth: \"750px\",\n        background: \"rgb(255, 255, 255)\",\n    });\n    var cssRules = \"\\n           .rbc-time-content>.rbc-time-gutter {\\n             display: none;\\n           }\\n           #big-calendar-container-id > div > div.rbc-time-view > div.rbc-time-content.cloned-calendar > div:nth-child(2),\\n           #big-calendar-container-id > div > div.rbc-time-view > div.rbc-time-content.cloned-calendar > div:nth-child(8),\\n           #big-calendar-container-id > div > div.rbc-time-view > div.rbc-time-content.og-calendar > div:nth-child(2),\\n           #big-calendar-container-id > div > div.rbc-time-view > div.rbc-time-content.og-calendar > div:nth-child(8) {\\n             display: none;\\n           }\\n           .rbc-time-content.cloned-calendar::before,\\n           .rbc-month-view.cloned-calendar::before {\\n             content: \\\"Clone\\\";\\n             position: absolute;\\n             top: 0px;\\n             background: #4caf50d1;\\n             font-size: 40px;\\n             line-height: 1.5;\\n             font-weight: bold;\\n             text-transform: uppercase;\\n             color: #000;\\n             z-index: 99999999;\\n           }\\n         \";\n    var cssRuleToCheck = \".rbc-time-content.cloned-calendar::before\";\n    var styleElementExists = $(\"style\").filter(function () {\n        return $(this).text().indexOf(cssRuleToCheck) !== -1;\n    }).length > 0;\n    if (!styleElementExists) {\n        var styleElement = document.createElement(\"style\");\n        styleElement.appendChild(document.createTextNode(cssRules));\n        $(\"head\").append(styleElement);\n    }\n    ogCalendar.css({\n        position: \"absolute\",\n        transform: \"translate(54%, 35px)\",\n        border: \"4px solid rgb(255, 92, 92)\",\n        zIndex: \"9\",\n        width: \"63%\",\n        background: \"#fff\",\n    });\n    cssRules = \"\\n           .rbc-time-content.og-calendar::before,\\n           .rbc-month-view.og-calendar::before {\\n             content: \\\"Original\\\";\\n             position: absolute;\\n             top: 0px;\\n             background: #ff3232d1;\\n             font-size: 40px;\\n             line-height: 1.5;\\n             font-weight: bold;\\n             text-transform: uppercase;\\n             color: #000;\\n             z-index: 99999999;\\n           }\\n         \";\n    cssRuleToCheck = \".rbc-time-content.og-calendar::before\";\n    styleElementExists =\n        $(\"style\").filter(function () {\n            return $(this).text().indexOf(cssRuleToCheck) !== -1;\n        }).length > 0;\n    if (!styleElementExists) {\n        var styleElement = document.createElement(\"style\");\n        styleElement.appendChild(document.createTextNode(cssRules));\n        $(\"head\").append(styleElement);\n    }\n}\nvar calendarInitialized = false;\nfunction waitCalendar() {\n    if (!calendarInitialized) {\n        initCalendar(false);\n        calendarInitialized = true;\n    }\n}\nfunction initSidebarCalendar() {\n    var ogSdbrCalendar = $(\".react-datepicker__month-container\");\n    var sidebarTimeout = null;\n    if (!ogSdbrCalendar) {\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"Tampermonkey waiting for sidebar calendar\");\n        sidebarTimeout = (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_2__.createTimeout)(initSidebarCalendar, 200);\n        return;\n    }\n    else {\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"Tampermonkey found sidebar calendar\");\n        if (sidebarTimeout !== null) {\n            (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_2__.clearMyTimeout)(sidebarTimeout);\n        }\n        // create style element to disable pointer events on calendar\n        var cssRules = \"\\n           .react-datepicker__month-container {\\n             pointer-events: none;\\n             user-select: none;\\n           }\\n           .react-datepicker__navigation {\\n             pointer-events: none;\\n             user-select: none;\\n           }\\n         \";\n        var cssRuleToCheck_2 = \".react-datepicker__month-container\";\n        var styleElementExists = $(\"style\").filter(function () {\n            return $(this).text().indexOf(cssRuleToCheck_2) !== -1;\n        }).length > 0;\n        if (!styleElementExists) {\n            var styleElement = document.createElement(\"style\");\n            styleElement.appendChild(document.createTextNode(cssRules));\n            $(\"head\").append(styleElement);\n        }\n    }\n}\nfunction setAppointmentCollapse() {\n    var appointmentSectionTitle = document.querySelector('[data-testid=\"cp-section-appointments\"]');\n    if (appointmentSectionTitle) {\n        appointmentSectionTitle.addEventListener(\"click\", function () {\n            // Using the non-null assertion operator\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey clicked section title\", appointmentSectionTitle.className);\n            if (appointmentSectionTitle.className != \"cp-sidebar-expandable-section undefined opened\") {\n                (0,_init_index__WEBPACK_IMPORTED_MODULE_1__.waitAppointmentSidebar)();\n            }\n        }, false);\n    }\n}\n\n\n\n//# sourceURL=webpack://typescript-script/./helpers/calendar/index.ts?");

/***/ }),

/***/ "./helpers/timeoutHelpers.ts":
/*!***********************************!*\
  !*** ./helpers/timeoutHelpers.ts ***!
  \***********************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   clearMyTimeout: () => (/* binding */ clearMyTimeout),\n/* harmony export */   createTimeout: () => (/* binding */ createTimeout)\n/* harmony export */ });\nvar timeoutIds = [];\nfunction createTimeout(timeoutFunction, delay) {\n    var timeoutId = window.setTimeout(function () {\n        timeoutFunction();\n        timeoutIds = timeoutIds.filter(function (id) { return id !== timeoutId; });\n    }, delay);\n    timeoutIds.push(timeoutId);\n    return timeoutId;\n}\nfunction clearMyTimeout(timeoutId) {\n    if (!timeoutId) {\n        return;\n    }\n    window.clearTimeout(timeoutId);\n    timeoutIds = timeoutIds.filter(function (id) { return id !== timeoutId; });\n}\n\n\n\n//# sourceURL=webpack://typescript-script/./helpers/timeoutHelpers.ts?");

/***/ }),

/***/ "./helpers/ui/index.ts":
/*!*****************************!*\
  !*** ./helpers/ui/index.ts ***!
  \*****************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   addHoverEffect: () => (/* binding */ addHoverEffect),\n/* harmony export */   createPatientDialogIframe: () => (/* binding */ createPatientDialogIframe),\n/* harmony export */   generateIframe: () => (/* binding */ generateIframe),\n/* harmony export */   hideOverlay: () => (/* binding */ hideOverlay),\n/* harmony export */   removeHoverEffect: () => (/* binding */ removeHoverEffect),\n/* harmony export */   showInstructions: () => (/* binding */ showInstructions),\n/* harmony export */   showOverlay: () => (/* binding */ showOverlay)\n/* harmony export */ });\n/* harmony import */ var _utils_index__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../../utils/index */ \"./utils/index.ts\");\n/* harmony import */ var _init_index__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../../init/index */ \"./init/index.ts\");\n/* harmony import */ var _helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ../../helpers/timeoutHelpers */ \"./helpers/timeoutHelpers.ts\");\nvar __assign = (undefined && undefined.__assign) || function () {\n    __assign = Object.assign || function(t) {\n        for (var s, i = 1, n = arguments.length; i < n; i++) {\n            s = arguments[i];\n            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))\n                t[p] = s[p];\n        }\n        return t;\n    };\n    return __assign.apply(this, arguments);\n};\n\n\n\nvar isStagingEnv = location.href.includes(\"securestaging\") ? true : false;\nvar mishaURL = isStagingEnv ? \"qa.misha.vori.health/\" : \"misha.vorihealth.com/\";\nvar healthieAPIKey = GM_getValue(isStagingEnv ? \"healthieStagingApiKey\" : \"healthieApiKey\", \"\");\nvar routeURLs = {\n    schedule: \"schedule\",\n    careplan: \"careplan\",\n    goals: \"app/schedule\",\n    appointment: \"appointment\",\n    appointments: \"appointments\",\n    patientStatus: \"patientStatusStandalone\",\n    providerSchedule: \"provider-schedule\",\n    otpVerify: \"otpVerifyStandalone\",\n    createPatientDialog: \"createPatientDialog\",\n};\nvar styles = {\n    scheduleOverlay: {\n        display: \"inline-block\",\n        background: \"rgb(255, 255, 255)\",\n        maxWidth: \"90vw\", // fallback for browsers that don't support svw\n        width: \"100vw\",\n        height: \"90vh\", // fallback for browsers that don't support svh\n        overflow: \"hidden\",\n    },\n    patientDialogOverlay: {\n        display: \"inline-block\",\n        background: \"rgb(255, 255, 255)\",\n        maxWidth: \"30vw\", // fallback for browsers that don't support svw\n        width: \"30vw\",\n        height: \"80vh\", // fallback for browsers that don't support svh\n        overflow: \"hidden\",\n    },\n    appointmentDetailsOverlay: {\n        height: \"350px\",\n        width: \"100%\",\n        overflow: \"hidden\",\n    },\n    otpOverlay: {\n        width: \"500px\",\n        height: \"500px\",\n    },\n};\nfunction addHoverEffect(apiMsgLink) {\n    apiMsgLink.style.textDecoration = \"underline\";\n}\nfunction removeHoverEffect(apiMsgLink) {\n    apiMsgLink.style.textDecoration = \"none\";\n}\nfunction showOverlay(url, style) {\n    if (style === void 0) { style = {}; }\n    var $ = (0,_init_index__WEBPACK_IMPORTED_MODULE_1__.initJQuery)();\n    if (!$) {\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey waiting for jquery to load\");\n        (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_2__.createTimeout)(function () { return showOverlay(url, style); }, 200);\n        return;\n    }\n    else {\n        hideOverlay();\n        // Create overlay element\n        var overlay = $(\"<div>\").addClass(\"overlay-dialog\").css({\n            position: \"fixed\",\n            inset: \"0\",\n            zIndex: \"999\",\n            background: \"#000000d9\",\n            display: \"flex\",\n            flexDirection: \"column\",\n            placeContent: \"center\",\n            alignItems: \"center\",\n            justifyContent: \"center\",\n        });\n        $(overlay).on(\"click\", function () {\n            if ($(\".overlay-dialog\")) {\n                $(\".overlay-dialog\").remove();\n            }\n        });\n        // Create close button element\n        var closeButton = $(\"<span>\").addClass(\"close-button\").html(\"&times;\").css({\n            position: \"absolute\",\n            right: \"1rem\",\n            top: \"1rem\",\n            color: \"#fff\",\n            fontSize: \"2.5rem\",\n            cursor: \"pointer\",\n        });\n        $(closeButton).on(\"click\", function () {\n            if ($(\".overlay-dialog\")) {\n                $(\".overlay-dialog\").remove();\n            }\n        });\n        overlay.append(closeButton);\n        // Create dialog body element with iframe\n        var dialogBody = $(\"<div>\")\n            .addClass(\"dialog-body\")\n            .css(__assign({ background: \"#fff\", maxWidth: \"max(600px, 60vw)\", width: \"100vw\", height: \"80vh\", maxheight: \"80dvh\", overflowY: \"scroll\" }, style));\n        var iframe = generateIframe(url, style);\n        dialogBody.append(iframe); // Append iframe to dialog body\n        overlay.append(dialogBody); // Append dialog body to overlay\n        var existingOverlay = $(\".body\").find(\".overlay-dialog\");\n        if (existingOverlay.length === 0) {\n            $(\"body\").append(overlay); // Append overlay to body\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"Tampermonkey displayed overlay\");\n        }\n    }\n}\nfunction hideOverlay() {\n    var $ = (0,_init_index__WEBPACK_IMPORTED_MODULE_1__.initJQuery)();\n    if (!$) {\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey waiting for jquery to load\");\n        (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_2__.createTimeout)(hideOverlay, 200);\n        return;\n    }\n    else {\n        $(\".overlay-dialog\").remove();\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"Tampermonkey removed overlay\");\n    }\n}\nfunction createPatientDialogIframe() {\n    var $ = (0,_init_index__WEBPACK_IMPORTED_MODULE_1__.initJQuery)();\n    if (!$) {\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey waiting for jQuery to load\");\n        setTimeout(createPatientDialogIframe, 200);\n        return;\n    }\n    (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"jQuery is loaded, attempting to find 'Add Client' button\");\n    var addPatientBtn = $(\".add-client-container button:contains('Add Client')\");\n    if (addPatientBtn.length > 0) {\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"'Add Client' button found, proceeding to clone\");\n        var clonedBtn = addPatientBtn.clone();\n        addPatientBtn.replaceWith(clonedBtn);\n        clonedBtn.on(\"click\", function (e) {\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"Cloned 'Add Client' button clicked\");\n            e.stopPropagation();\n            showOverlay(\"\".concat(routeURLs.createPatientDialog), styles.patientDialogOverlay);\n        });\n    }\n    else {\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"'Add Client' button not found, retrying...\");\n        setTimeout(createPatientDialogIframe, 200);\n    }\n}\nfunction generateIframe(routeURL, options) {\n    if (options === void 0) { options = {}; }\n    var $ = (0,_init_index__WEBPACK_IMPORTED_MODULE_1__.initJQuery)();\n    var className = \"misha-iframe-container\";\n    var iframeStyles = __assign({ height: options.height || \"100vh\", width: options.width || \"100%\" }, options);\n    var iframeStyleString = Object.entries(iframeStyles)\n        .map(function (_a) {\n        var property = _a[0], value = _a[1];\n        return \"\".concat((0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.convertToCSSProperty)(property), \": \").concat(value, \";\");\n    })\n        .join(\" \");\n    if (!$) {\n        (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_2__.createTimeout)(function () {\n            generateIframe(routeURL);\n        }, 200);\n        return;\n    }\n    else {\n        var iframeElement = $(\"<div>\")\n            .css(__assign({ padding: \"0\" }, options))\n            .addClass(className);\n        var iframeContent = $(\"<iframe>\", {\n            id: \"MishaFrame\",\n            title: \"Misha iFrame\",\n            style: iframeStyleString,\n            src: \"https://\".concat(mishaURL).concat(routeURL),\n        });\n        iframeElement.append(iframeContent);\n        return iframeElement;\n    }\n}\nfunction showInstructions() {\n    if (document.querySelector(\".api-keys-wrapper\") && document.querySelector(\".api-keys-input-button-wrapper\")) {\n        var apiKeyInputContainer = document.querySelector(\".api-keys-input-button-wrapper\");\n        if (apiKeyInputContainer && healthieAPIKey === \"\") {\n            var instructions = document.createElement(\"p\");\n            instructions.innerHTML =\n                \"<b>Vori Health Instructions</b><br />\" +\n                    '1. Click the button below that says <i>\"Add API Key\"</i><br />' +\n                    '2. Enter a memorable name in the <i>API Key Name</i> field then click on \"Create API Key\"<br />' +\n                    \"3. The API Key should now be listed below. Copy the text under the <i>Key</i> column.<br />\" +\n                    '4. Now under the \"Connect to Vori Health\" section, paste the key in the box that says <i>Enter your API Key here</i>, and then select the \"Link Api key\" button.<br />' +\n                    '5. You should see a message saying \"API key saved successfully\"<br />';\n            instructions.classList.add(\"vori-instruction-message\");\n            instructions.style.display = \"block\";\n            instructions.style.position = \"relative\";\n            instructions.style.background = \"rgb(227 229 50 / 35%)\";\n            instructions.style.color = \"#16284a\";\n            instructions.style.minHeight = \"42px\";\n            instructions.style.padding = \"10px\";\n            instructions.style.marginTop = \"14px\";\n            apiKeyInputContainer.insertAdjacentElement(\"afterend\", instructions);\n        }\n    }\n    else {\n        //wait for content load\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey waiting to show instructions\");\n        (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_2__.createTimeout)(showInstructions, 200);\n    }\n}\n\n\n\n//# sourceURL=webpack://typescript-script/./helpers/ui/index.ts?");

/***/ }),

/***/ "./index.ts":
/*!******************!*\
  !*** ./index.ts ***!
  \******************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   addHoverEffect: () => (/* reexport safe */ _helpers_ui_index__WEBPACK_IMPORTED_MODULE_4__.addHoverEffect),\n/* harmony export */   clearMyTimeout: () => (/* reexport safe */ _helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_5__.clearMyTimeout),\n/* harmony export */   convertToCSSProperty: () => (/* reexport safe */ _utils_index__WEBPACK_IMPORTED_MODULE_2__.convertToCSSProperty),\n/* harmony export */   createPatientDialogIframe: () => (/* reexport safe */ _helpers_ui_index__WEBPACK_IMPORTED_MODULE_4__.createPatientDialogIframe),\n/* harmony export */   createTimeout: () => (/* reexport safe */ _helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_5__.createTimeout),\n/* harmony export */   debugLog: () => (/* reexport safe */ _utils_index__WEBPACK_IMPORTED_MODULE_2__.debugLog),\n/* harmony export */   generateIframe: () => (/* reexport safe */ _helpers_ui_index__WEBPACK_IMPORTED_MODULE_4__.generateIframe),\n/* harmony export */   healthieGQL: () => (/* reexport safe */ _api_index__WEBPACK_IMPORTED_MODULE_0__.healthieGQL),\n/* harmony export */   hideOverlay: () => (/* reexport safe */ _helpers_ui_index__WEBPACK_IMPORTED_MODULE_4__.hideOverlay),\n/* harmony export */   initAddButton: () => (/* reexport safe */ _init_index__WEBPACK_IMPORTED_MODULE_1__.initAddButton),\n/* harmony export */   initBookAppointmentButton: () => (/* reexport safe */ _init_index__WEBPACK_IMPORTED_MODULE_1__.initBookAppointmentButton),\n/* harmony export */   initCalendar: () => (/* reexport safe */ _helpers_calendar_index__WEBPACK_IMPORTED_MODULE_3__.initCalendar),\n/* harmony export */   initCalendarHeaderBtns: () => (/* reexport safe */ _helpers_calendar_index__WEBPACK_IMPORTED_MODULE_3__.initCalendarHeaderBtns),\n/* harmony export */   initJQuery: () => (/* reexport safe */ _init_index__WEBPACK_IMPORTED_MODULE_1__.initJQuery),\n/* harmony export */   initSidebarCalendar: () => (/* reexport safe */ _helpers_calendar_index__WEBPACK_IMPORTED_MODULE_3__.initSidebarCalendar),\n/* harmony export */   isAPIconnected: () => (/* reexport safe */ _api_index__WEBPACK_IMPORTED_MODULE_0__.isAPIconnected),\n/* harmony export */   removeHoverEffect: () => (/* reexport safe */ _helpers_ui_index__WEBPACK_IMPORTED_MODULE_4__.removeHoverEffect),\n/* harmony export */   rescheduleAppointment: () => (/* reexport safe */ _init_index__WEBPACK_IMPORTED_MODULE_1__.rescheduleAppointment),\n/* harmony export */   setAppointmentCollapse: () => (/* reexport safe */ _helpers_calendar_index__WEBPACK_IMPORTED_MODULE_3__.setAppointmentCollapse),\n/* harmony export */   showBothCalendars: () => (/* reexport safe */ _helpers_calendar_index__WEBPACK_IMPORTED_MODULE_3__.showBothCalendars),\n/* harmony export */   showInstructions: () => (/* reexport safe */ _helpers_ui_index__WEBPACK_IMPORTED_MODULE_4__.showInstructions),\n/* harmony export */   showOverlay: () => (/* reexport safe */ _helpers_ui_index__WEBPACK_IMPORTED_MODULE_4__.showOverlay),\n/* harmony export */   verifyEmailPhone: () => (/* reexport safe */ _init_index__WEBPACK_IMPORTED_MODULE_1__.verifyEmailPhone),\n/* harmony export */   verifyEmailPhoneButtons: () => (/* reexport safe */ _init_index__WEBPACK_IMPORTED_MODULE_1__.verifyEmailPhoneButtons),\n/* harmony export */   waitAddAppointmentsBtn: () => (/* reexport safe */ _init_index__WEBPACK_IMPORTED_MODULE_1__.waitAddAppointmentsBtn),\n/* harmony export */   waitAppointmentSidebar: () => (/* reexport safe */ _init_index__WEBPACK_IMPORTED_MODULE_1__.waitAppointmentSidebar),\n/* harmony export */   waitAppointmentsHome: () => (/* reexport safe */ _init_index__WEBPACK_IMPORTED_MODULE_1__.waitAppointmentsHome),\n/* harmony export */   waitAppointmentsProfile: () => (/* reexport safe */ _init_index__WEBPACK_IMPORTED_MODULE_1__.waitAppointmentsProfile),\n/* harmony export */   waitCalendar: () => (/* reexport safe */ _helpers_calendar_index__WEBPACK_IMPORTED_MODULE_3__.waitCalendar),\n/* harmony export */   waitCarePlan: () => (/* reexport safe */ _init_index__WEBPACK_IMPORTED_MODULE_1__.waitCarePlan),\n/* harmony export */   waitClientList: () => (/* reexport safe */ _init_index__WEBPACK_IMPORTED_MODULE_1__.waitClientList),\n/* harmony export */   waitForAddPatientButton: () => (/* reexport safe */ _init_index__WEBPACK_IMPORTED_MODULE_1__.waitForAddPatientButton),\n/* harmony export */   waitForMishaMessages: () => (/* reexport safe */ _utils_index__WEBPACK_IMPORTED_MODULE_2__.waitForMishaMessages),\n/* harmony export */   waitGoalTab: () => (/* reexport safe */ _init_index__WEBPACK_IMPORTED_MODULE_1__.waitGoalTab),\n/* harmony export */   waitInfo: () => (/* reexport safe */ _init_index__WEBPACK_IMPORTED_MODULE_1__.waitInfo)\n/* harmony export */ });\n/* harmony import */ var _api_index__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./api/index */ \"./api/index.ts\");\n/* harmony import */ var _init_index__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./init/index */ \"./init/index.ts\");\n/* harmony import */ var _utils_index__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ./utils/index */ \"./utils/index.ts\");\n/* harmony import */ var _helpers_calendar_index__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! ./helpers/calendar/index */ \"./helpers/calendar/index.ts\");\n/* harmony import */ var _helpers_ui_index__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(/*! ./helpers/ui/index */ \"./helpers/ui/index.ts\");\n/* harmony import */ var _helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(/*! ./helpers/timeoutHelpers */ \"./helpers/timeoutHelpers.ts\");\n// Import from api folder\n\n// Import from init folder\n\n// Import from utils folder\n\n// Import from helpers/calendar folder\n\n// Import from helpers/ui folder\n\n// Import from helpers/timeoutHelpers.ts\n\nvar previousUrl = \"\";\nvar carePlanLoopLock = 0;\nvar copyComplete = -1;\nvar timeoutIds = [];\nvar urlValidation = {\n    apiKeys: /\\/settings\\/api_keys$/,\n    appointments: /\\/appointments|\\/organization|\\/providers\\//,\n    appointmentsHome: /^https?:\\/\\/[^/]+\\.com(\\/overview|\\/)?$/,\n    appointmentsProfile: /^https?:\\/\\/([^\\/]+)?\\.?([^\\/]+)\\/users\\/\\d+(?:\\/(?:Overview))?\\/?$/,\n    membership: /^https?:\\/\\/([^\\/]+)?\\.?([^\\/]+)\\/users\\/\\d+(?:\\/(?:Overview|Actions))?\\/?$/,\n    verifyEmailPhone: /^https?:\\/\\/([^\\/]+)?\\.?([^\\/]+)\\/users\\/\\d+(?:\\/(?:Actions))\\/?$/,\n    carePlan: /\\/all_plans$/,\n    clientList: /\\/clients\\/active/,\n    conversations: /\\/conversations/,\n    goals: /\\/users/,\n};\nvar observeDOMChanges = function (mutations, observer) {\n    // Handle URL changes\n    if (location.href !== previousUrl) {\n        previousUrl = location.href;\n        carePlanLoopLock = 0;\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_2__.debugLog)(\"tampermonkey URL changed to \".concat(location.href));\n        // Clear all timeouts\n        timeoutIds.forEach(function (id) { return clearTimeout(id); });\n        timeoutIds = [];\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_2__.waitForMishaMessages)();\n        // URL checks and function calls\n        if (urlValidation.carePlan.test(location.href)) {\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_2__.debugLog)(\"tampermonkey calls waitCarePlan\");\n            (0,_init_index__WEBPACK_IMPORTED_MODULE_1__.waitCarePlan)();\n        }\n        if (urlValidation.goals.test(location.href)) {\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_2__.debugLog)(\"tampermonkey calls waitGoalTab\");\n            (0,_init_index__WEBPACK_IMPORTED_MODULE_1__.waitGoalTab)();\n        }\n        if (urlValidation.appointmentsProfile.test(location.href)) {\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_2__.debugLog)(\"tampermonkey calls waitAppointmentsProfile and addMembershipAndOnboarding\");\n            (0,_init_index__WEBPACK_IMPORTED_MODULE_1__.waitAppointmentsProfile)();\n        }\n        if (urlValidation.membership.test(location.href)) {\n            (0,_init_index__WEBPACK_IMPORTED_MODULE_1__.addMembershipAndOnboarding)();\n        }\n        if (urlValidation.verifyEmailPhone.test(location.href)) {\n            (0,_init_index__WEBPACK_IMPORTED_MODULE_1__.verifyEmailPhone)();\n        }\n        if (urlValidation.apiKeys.test(location.href)) {\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_2__.debugLog)(\"tampermonkey calls waitSettingsAPIpage and showInstructions\");\n            (0,_api_index__WEBPACK_IMPORTED_MODULE_0__.waitSettingsAPIpage)();\n            (0,_helpers_ui_index__WEBPACK_IMPORTED_MODULE_4__.showInstructions)();\n        }\n        if (urlValidation.appointments.test(location.href)) {\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_2__.debugLog)(\"tampermonkey calls waitAddAppointmentsBtn and waitCalendar\");\n            (0,_init_index__WEBPACK_IMPORTED_MODULE_1__.waitAddAppointmentsBtn)();\n            (0,_helpers_calendar_index__WEBPACK_IMPORTED_MODULE_3__.waitCalendar)();\n        }\n        if (urlValidation.appointmentsHome.test(location.href)) {\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_2__.debugLog)(\"tampermonkey calls waitAppointmentsHome\");\n            (0,_init_index__WEBPACK_IMPORTED_MODULE_1__.waitAppointmentsHome)();\n        }\n        if (urlValidation.conversations.test(location.href)) {\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_2__.debugLog)(\"tampermonkey calls waitAppointmentSidebar and waitInfo\");\n            (0,_init_index__WEBPACK_IMPORTED_MODULE_1__.waitAppointmentSidebar)();\n            (0,_init_index__WEBPACK_IMPORTED_MODULE_1__.waitInfo)();\n        }\n        if (urlValidation.clientList.test(location.href)) {\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_2__.debugLog)(\"tampermonkey calls waitClientList\");\n            (0,_init_index__WEBPACK_IMPORTED_MODULE_1__.waitClientList)();\n            (0,_init_index__WEBPACK_IMPORTED_MODULE_1__.waitForAddPatientButton)();\n        }\n        (0,_api_index__WEBPACK_IMPORTED_MODULE_0__.isAPIconnected)();\n    }\n    else {\n        if (carePlanLoopLock > 1 && location.href.includes(\"all_plans\")) {\n            var iframe = document.querySelector(\"#MishaFrame.cp-tab-contents\");\n            if (!iframe) {\n                carePlanLoopLock = 0;\n                var goalsTab = document.querySelector('[data-testid=\"goals-tab-btn\"]');\n                if (goalsTab) {\n                    var parentDiv = goalsTab.closest(\"div\");\n                    parentDiv === null || parentDiv === void 0 ? void 0 : parentDiv.remove();\n                }\n                (0,_init_index__WEBPACK_IMPORTED_MODULE_1__.waitCarePlan)();\n            }\n        }\n    }\n    var calendarTargetClasses = [\"rbc-time-content\", \"rbc-month-view\"];\n    var homeTargetClasses = [\"provider-home-content\"];\n    var basicInfoTargetClasses = [\"cp-sidebar-expandable-section\"];\n    // Helper function to process NodeList\n    var processNodeList = function (nodeList, targetClasses) {\n        return Array.from(nodeList).some(function (node) {\n            if (node instanceof Element) {\n                return targetClasses.some(function (className) { return node.classList.contains(className) || node.querySelector(\".\".concat(className)) !== null; });\n            }\n            return false;\n        });\n    };\n    var _loop_1 = function (mutation) {\n        var target = mutation.target, addedNodes = mutation.addedNodes, removedNodes = mutation.removedNodes;\n        // Check for calendar-related changes\n        if ((target instanceof Element && calendarTargetClasses.some(function (className) { return target.classList.contains(className); })) ||\n            processNodeList(addedNodes, calendarTargetClasses) ||\n            processNodeList(removedNodes, calendarTargetClasses)) {\n            observer.disconnect();\n            var clonedCalendar = document.querySelector(\".cloned-calendar\");\n            if (!clonedCalendar)\n                copyComplete++;\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_2__.debugLog)(\"increased copy complete in observer\", copyComplete);\n            // Replace with the appropriate call if initCalendar expects an argument\n            (0,_helpers_calendar_index__WEBPACK_IMPORTED_MODULE_3__.initCalendar)(!clonedCalendar);\n            observer.observe(document.documentElement, { childList: true, subtree: true });\n            return \"break\";\n        }\n        // Check for home-related changes\n        if ((target instanceof Element && homeTargetClasses.some(function (className) { return target.classList.contains(className); })) ||\n            processNodeList(addedNodes, homeTargetClasses) ||\n            processNodeList(removedNodes, homeTargetClasses)) {\n            observer.disconnect();\n            (0,_init_index__WEBPACK_IMPORTED_MODULE_1__.waitAppointmentsHome)();\n            observer.observe(document.documentElement, { childList: true, subtree: true });\n            return \"break\";\n        }\n        // Check for basic info-related changes\n        if ((target instanceof Element && basicInfoTargetClasses.some(function (className) { return target.classList.contains(className); })) ||\n            processNodeList(addedNodes, basicInfoTargetClasses) ||\n            processNodeList(removedNodes, basicInfoTargetClasses)) {\n            observer.disconnect();\n            (0,_init_index__WEBPACK_IMPORTED_MODULE_1__.addMembershipAndOnboarding)();\n            observer.observe(document.documentElement, { childList: true, subtree: true });\n            return \"break\";\n        }\n    };\n    for (var _i = 0, mutations_1 = mutations; _i < mutations_1.length; _i++) {\n        var mutation = mutations_1[_i];\n        var state_1 = _loop_1(mutation);\n        if (state_1 === \"break\")\n            break;\n    }\n};\n// Configuration for the observer\nvar config = { subtree: true, childList: true };\nvar observer = new MutationObserver(observeDOMChanges);\nobserver.observe(document.documentElement, config);\n// Export all the necessary functions\n\n\n\n//# sourceURL=webpack://typescript-script/./index.ts?");

/***/ }),

/***/ "./init/index.ts":
/*!***********************!*\
  !*** ./init/index.ts ***!
  \***********************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   addMembershipAndOnboarding: () => (/* binding */ addMembershipAndOnboarding),\n/* harmony export */   initAddButton: () => (/* binding */ initAddButton),\n/* harmony export */   initBookAppointmentButton: () => (/* binding */ initBookAppointmentButton),\n/* harmony export */   initJQuery: () => (/* binding */ initJQuery),\n/* harmony export */   rescheduleAppointment: () => (/* binding */ rescheduleAppointment),\n/* harmony export */   verifyEmailPhone: () => (/* binding */ verifyEmailPhone),\n/* harmony export */   verifyEmailPhoneButtons: () => (/* binding */ verifyEmailPhoneButtons),\n/* harmony export */   waitAddAppointmentsBtn: () => (/* binding */ waitAddAppointmentsBtn),\n/* harmony export */   waitAppointmentSidebar: () => (/* binding */ waitAppointmentSidebar),\n/* harmony export */   waitAppointmentsHome: () => (/* binding */ waitAppointmentsHome),\n/* harmony export */   waitAppointmentsProfile: () => (/* binding */ waitAppointmentsProfile),\n/* harmony export */   waitCarePlan: () => (/* binding */ waitCarePlan),\n/* harmony export */   waitClientList: () => (/* binding */ waitClientList),\n/* harmony export */   waitForAddPatientButton: () => (/* binding */ waitForAddPatientButton),\n/* harmony export */   waitGoalTab: () => (/* binding */ waitGoalTab),\n/* harmony export */   waitInfo: () => (/* binding */ waitInfo)\n/* harmony export */ });\n/* harmony import */ var _utils_index__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../utils/index */ \"./utils/index.ts\");\n/* harmony import */ var _helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../helpers/timeoutHelpers */ \"./helpers/timeoutHelpers.ts\");\n/* harmony import */ var _api_index__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ../api/index */ \"./api/index.ts\");\n/* harmony import */ var _helpers_ui_index__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! ../helpers/ui/index */ \"./helpers/ui/index.ts\");\n/* harmony import */ var _helpers_calendar_index__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(/*! ../helpers/calendar/index */ \"./helpers/calendar/index.ts\");\n\n\n\n\n\nvar isStagingEnv = location.href.includes(\"securestaging\") ? true : false;\nvar mishaURL = isStagingEnv ? \"qa.misha.vori.health/\" : \"misha.vorihealth.com/\";\nvar healthieAPIKey = GM_getValue(isStagingEnv ? \"healthieStagingApiKey\" : \"healthieApiKey\", \"\");\nvar patientNumber = \"\";\nvar carePlanLoopLock = 0;\nvar routeURLs = {\n    schedule: \"schedule\",\n    careplan: \"careplan\",\n    goals: \"app/schedule\",\n    appointment: \"appointment\",\n    appointments: \"appointments\",\n    patientStatus: \"patientStatusStandalone\",\n    providerSchedule: \"provider-schedule\",\n    otpVerify: \"otpVerifyStandalone\",\n    createPatientDialog: \"createPatientDialog\",\n};\nvar styles = {\n    scheduleOverlay: {\n        display: \"inline-block\",\n        background: \"rgb(255, 255, 255)\",\n        maxWidth: \"90vw\", // fallback for browsers that don't support svw\n        width: \"100vw\",\n        height: \"90vh\", // fallback for browsers that don't support svh\n        overflow: \"hidden\",\n    },\n    patientDialogOverlay: {\n        display: \"inline-block\",\n        background: \"rgb(255, 255, 255)\",\n        maxWidth: \"30vw\", // fallback for browsers that don't support svw\n        width: \"30vw\",\n        height: \"80vh\", // fallback for browsers that don't support svh\n        overflow: \"hidden\",\n    },\n    appointmentDetailsOverlay: {\n        height: \"350px\",\n        width: \"100%\",\n        overflow: \"hidden\",\n    },\n    otpOverlay: {\n        width: \"500px\",\n        height: \"500px\",\n    },\n};\nfunction initAddButton() {\n    var $ = initJQuery();\n    if (!$) {\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey waiting for jquery to load\");\n        (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(function () {\n            (0,_helpers_ui_index__WEBPACK_IMPORTED_MODULE_3__.showOverlay)(\"dummy-url\", {}); // to do\n        }, 200);\n        return;\n    }\n    else {\n        var activeTab = $(\".calendar-tabs\").find(\".tab-item.active\");\n        var availabilitiesTab = activeTab && activeTab.text().toLowerCase().includes(\"availability\");\n        if (availabilitiesTab) {\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"Tampermonkey calendar is on availability tab - nothing to do here\");\n            return;\n        }\n        var addAppointmentBtn = $(\".rbc-btn-group.last-btn-group\").find(\"button:contains('Add')\")[0];\n        if (addAppointmentBtn) {\n            var clonedBtn = $(addAppointmentBtn).clone();\n            $(addAppointmentBtn).replaceWith(clonedBtn);\n            clonedBtn.on(\"click\", function (e) {\n                e.stopPropagation();\n                //https://qa.misha.vori.health/schedule/\n                (0,_helpers_ui_index__WEBPACK_IMPORTED_MODULE_3__.showOverlay)(\"\".concat(routeURLs.schedule), styles.scheduleOverlay);\n            });\n        }\n        else {\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey waiting for add appointment button\");\n            (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(waitAddAppointmentsBtn, 200);\n        }\n    }\n}\nfunction initBookAppointmentButton() {\n    if (!$) {\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey waiting for jquery to load\");\n        (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(function () { return (0,_helpers_ui_index__WEBPACK_IMPORTED_MODULE_3__.showOverlay)(\"\".concat(routeURLs.schedule, \"/\").concat(patientNumber), styles.scheduleOverlay); }, 200);\n        return;\n    }\n    else {\n        var bookAppointmentBtn = $(\".insurance-authorization-section\").find(\"button:contains('Book Appointment')\")[0];\n        if (bookAppointmentBtn) {\n            var patientNumber_1 = location.href.split(\"/\")[4];\n            var clonedBtn = $(bookAppointmentBtn).clone();\n            $(bookAppointmentBtn).replaceWith(clonedBtn);\n            clonedBtn.on(\"click\", function (e) {\n                e.stopPropagation();\n                (0,_helpers_ui_index__WEBPACK_IMPORTED_MODULE_3__.showOverlay)(\"\".concat(routeURLs.schedule, \"/\").concat(patientNumber_1), styles.scheduleOverlay);\n            });\n        }\n        else {\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey waiting for book appointment button\");\n            (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(initBookAppointmentButton, 200);\n        }\n    }\n}\nfunction rescheduleAppointment(appointmentID) {\n    (0,_helpers_ui_index__WEBPACK_IMPORTED_MODULE_3__.showOverlay)(\"\".concat(routeURLs.schedule, \"/\").concat(appointmentID), styles.scheduleOverlay);\n}\nfunction addMembershipAndOnboarding() {\n    // Get phone icon and related column\n    var phoneColumn = document.querySelector(\".col-12.col-sm-6:has(.telephone-icon)\");\n    if (phoneColumn && phoneColumn.parentNode) {\n        var iframeAdded = phoneColumn.parentNode.querySelector(\".misha-iframe-container\");\n        if (!iframeAdded) {\n            // Get the patient number from the URL\n            var patientNumber_2 = location.href.split(\"/\")[4];\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey patient number\", patientNumber_2);\n            // Create iframe (generateIframe returns a jQuery object)\n            var iframe = (0,_helpers_ui_index__WEBPACK_IMPORTED_MODULE_3__.generateIframe)(\"\".concat(routeURLs.patientStatus, \"/\").concat(patientNumber_2), { height: \"190px\", width: \"400px\" });\n            // Check if iframe already exists\n            var iframeExists = phoneColumn.parentNode.querySelector(\".misha-iframe-container\");\n            // Add iframe after phone element if it does not exist\n            if (!iframeExists) {\n                phoneColumn.parentNode.insertBefore(iframe[0], phoneColumn.nextSibling);\n            }\n        }\n    }\n    else {\n        // Wait for content load and retry\n        (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(function () {\n            addMembershipAndOnboarding();\n        }, 200);\n    }\n}\nfunction verifyEmailPhone() {\n    (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey verifyEmailPhone\");\n    var clientInfoPane = document.getElementsByClassName(\"client-info-pane\");\n    if (clientInfoPane.length > 0) {\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey found client info pane\");\n        var saveButtons = document.getElementsByClassName(\"client-profile-submit-button healthie-button primary-button small-button float-right\");\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey save button\", saveButtons);\n        if (saveButtons.length > 0) {\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey found save button\", saveButtons);\n            var saveButton = saveButtons[0]; // Cast to HTMLElement\n            saveButton.onclick = function () {\n                (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(function () {\n                    window.location.reload();\n                }, 1000);\n            };\n        }\n        var clientInfoPaneObj = clientInfoPane[0];\n        // Load invisible iframe for getPatientInfo to determine verification status of phone/email\n        patientNumber = location.href.split(\"/\")[location.href.split(\"/\").length - 2];\n        var iframe = (0,_helpers_ui_index__WEBPACK_IMPORTED_MODULE_3__.generateIframe)(\"getPatientInfo?id=\".concat(patientNumber), {\n            position: \"absolute\",\n            height: \"0px\",\n            width: \"0px\",\n            border: \"0px\",\n        });\n        // Append to document body\n        $(clientInfoPaneObj).append(iframe);\n    }\n    else {\n        (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(function () {\n            verifyEmailPhone();\n        }, 200);\n    }\n}\nfunction initJQuery() {\n    var $ = unsafeWindow.jQuery;\n    if ($ && $ !== undefined && typeof $ === \"function\") {\n        return $;\n    }\n    else {\n        var script = document.createElement(\"script\");\n        script.src = \"https://code.jquery.com/jquery-3.7.0.min.js\";\n        script.type = \"text/javascript\";\n        script.onload = function () {\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey jquery loaded successfully\");\n        };\n        document.getElementsByTagName(\"head\")[0].appendChild(script);\n        (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(initJQuery, 200);\n    }\n}\ninitJQuery();\nfunction verifyEmailPhoneButtons(isEmail) {\n    var field = isEmail ? document.getElementById(\"email\") : document.getElementById(\"phone_number\");\n    if (field && field.value != \"\") {\n        patientNumber = location.href.split(\"/\")[location.href.split(\"/\").length - 2];\n        var verifyOverlayURL_1 = routeURLs.otpVerify + \"?id=\".concat(patientNumber);\n        verifyOverlayURL_1 += isEmail ? \"&email=\".concat(field.value) : \"&phone=\".concat(field.value);\n        var existingButton = isEmail ? document.getElementById(\"verify-email-button\") : document.getElementById(\"verify-phone-button\");\n        if (!existingButton) {\n            // Creating a button style string\n            var buttonStyle = {\n                background: \"#026460\",\n                color: \"white\",\n                borderRadius: \"2px\",\n            };\n            var buttonStyleString = Object.entries(buttonStyle)\n                .map(function (_a) {\n                var property = _a[0], value = _a[1];\n                return \"\".concat(property, \": \").concat(value, \";\");\n            })\n                .join(\" \");\n            // Create and insert the button\n            var button = $(\"<button>\", {\n                id: isEmail ? \"verify-email-button\" : \"verify-phone-button\",\n                text: \"Verify\",\n                style: buttonStyleString,\n                type: \"button\",\n                click: function () {\n                    (0,_helpers_ui_index__WEBPACK_IMPORTED_MODULE_3__.showOverlay)(verifyOverlayURL_1, styles.otpOverlay);\n                },\n            });\n            if (field.parentNode) {\n                field.parentNode.insertBefore(button[0], field.nextSibling);\n                // Adjusting the container style\n                if (field.parentElement) {\n                    var containerStyle = field.parentElement.style;\n                    containerStyle.display = \"flex\";\n                    containerStyle.flexDirection = \"row\";\n                }\n            }\n        }\n    }\n}\nfunction waitAddAppointmentsBtn() {\n    var $ = initJQuery();\n    if (!$) {\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey jquery not loaded\");\n        (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(waitAddAppointmentsBtn, 200);\n        return;\n    }\n    else {\n        initAddButton();\n    }\n}\nfunction waitAppointmentSidebar() {\n    var appointmentWindow = document.querySelector('[data-testid=\"cp-section-appointments\"]');\n    var goalsTab = document.querySelector('[data-testid=\"tab-goals\"]');\n    (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey goals tab \", goalsTab);\n    goalsTab && goalsTab.remove();\n    var actionLinks = Array.from(document.getElementsByClassName(\"healthie-action-link\"));\n    if (appointmentWindow && actionLinks[0]) {\n        goalsTab && goalsTab.remove();\n        actionLinks.forEach(function (element) {\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey action link found\", element);\n            element.remove();\n        });\n    }\n    else {\n        //wait for content load\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey waiting to hide chat links\");\n        (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(waitAppointmentSidebar, 500);\n    }\n}\nfunction waitAppointmentsHome() {\n    var $ = initJQuery();\n    if (!$) {\n        (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(waitAppointmentsHome, 200);\n        return;\n    }\n    else {\n        var appointmentWindow = document.getElementsByClassName(\"provider-home-appointments\");\n        if (appointmentWindow.length > 0) {\n            var appointmentWindowObj_1 = appointmentWindow[0];\n            while (appointmentWindowObj_1.childNodes.length > 1) {\n                var lastChild = appointmentWindowObj_1.lastChild;\n                if (lastChild) {\n                    var childClassName = lastChild.className;\n                    (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey removing child\", childClassName);\n                    appointmentWindowObj_1.removeChild(lastChild);\n                }\n            }\n            patientNumber = location.href.split(\"/\")[location.href.split(\"/\").length - 1];\n            var getCurrentUserQuery = \"query user{\\n         user(or_current_user: true){\\n          id\\n        }\\n        }\";\n            var getCurrentUserPayload = JSON.stringify({\n                query: getCurrentUserQuery,\n            });\n            (0,_api_index__WEBPACK_IMPORTED_MODULE_2__.healthieGQL)(getCurrentUserPayload).then(function (response) {\n                var userId = response.data.user.id;\n                var iframeSrc = \"https://\".concat(mishaURL).concat(routeURLs.providerSchedule, \"/\").concat(userId);\n                var existingIframe = document.querySelector(\"iframe[src=\\\"\".concat(iframeSrc, \"\\\"]\"));\n                if (!existingIframe) {\n                    var iframe = (0,_helpers_ui_index__WEBPACK_IMPORTED_MODULE_3__.generateIframe)(\"\".concat(routeURLs.providerSchedule, \"/\").concat(userId));\n                    $(appointmentWindowObj_1).append(iframe);\n                }\n            });\n        }\n        else {\n            (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(waitAppointmentsHome, 200);\n        }\n    }\n}\nfunction waitAppointmentsProfile() {\n    var $ = initJQuery();\n    if (!$) {\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey jquery not loaded\");\n        (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(waitAppointmentsProfile, 200);\n        return;\n    }\n    else {\n        initBookAppointmentButton();\n        // check to see if the appointment view contents have loaded\n        var appointmentWindow = $(\".insurance-authorization-section div\").filter(function () {\n            return $(this).find(\".tabs.apps-tabs\").length > 0;\n        })[0];\n        if (appointmentWindow) {\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey found appointment view on user profile\");\n            $(appointmentWindow).css({ margin: \"0\", padding: \"3px\" });\n            // get the parent with class .column.is-6 and change the width to 100%\n            var parent_1 = $(appointmentWindow).closest(\".column.is-6\");\n            parent_1\n                .css({\n                width: \"98%\",\n                minHeight: \"420px\",\n                maxHeight: \"max(60vh, 560px)\",\n                overflow: \"scroll\",\n                marginTop: \"2rem\",\n                padding: \"0\",\n            })\n                .closest(\".columns\") // also adjust style of grandparent\n                .css({\n                display: \"flex\",\n                flexDirection: \"column\",\n            });\n            // also adjust width of packages section\n            $(\".insurance-authorization-section.cp-section.with-dropdown-menus-for-packgs\").closest(\".column.is-6\").css(\"width\", \"100%\");\n            // remove all children of appointments section\n            while (appointmentWindow.childNodes.length > 0) {\n                var lastChild = appointmentWindow.lastChild;\n                if (lastChild) {\n                    var childClassName = lastChild.className;\n                    (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey removing child\", childClassName);\n                    appointmentWindow.removeChild(lastChild);\n                }\n            }\n            // example of url to load - https://securestaging.gethealthie.com/users/388687\n            // can also be - https://securestaging.gethealthie.com/users/388687/Overview\n            var patientID = location.href.split(\"/\")[4];\n            var iframe = (0,_helpers_ui_index__WEBPACK_IMPORTED_MODULE_3__.generateIframe)(\"\".concat(routeURLs.appointments, \"/patient/\").concat(patientID));\n            $(appointmentWindow).append(iframe);\n        }\n        else {\n            // wait for content load\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey waiting appointment view on user profile\");\n            (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(waitAppointmentsProfile, 200);\n        }\n    }\n}\nfunction handleCarePlanTabClick(cpTabContents, patientNumber, healthieAPIKey) {\n    if (location.href.includes(\"all_plans\")) {\n        if (healthieAPIKey !== \"\") {\n            cpTabContents && cpTabContents.empty();\n        }\n        waitCarePlan();\n    }\n}\nfunction waitClientList() {\n    var $ = initJQuery();\n    var bookLinks = Array.from(document.querySelectorAll(\"button\")).filter(function (e) { return e.textContent === \"Book Session\"; });\n    (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey waiting to update book link\", bookLinks);\n    if (bookLinks.length > 0) {\n        bookLinks.forEach(function (element) {\n            var _a, _b;\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey book link found\", element);\n            var parentElement = element.parentElement;\n            if (parentElement) {\n                var ID_1 = (_b = (_a = parentElement.getAttribute(\"data-testid\")) === null || _a === void 0 ? void 0 : _a.split(\"-\").pop()) !== null && _b !== void 0 ? _b : \"\";\n                var bookButton = $(element);\n                var clonedButton = bookButton.clone(true);\n                clonedButton.on(\"click\", function (e) {\n                    e.stopPropagation();\n                    (0,_helpers_ui_index__WEBPACK_IMPORTED_MODULE_3__.showOverlay)(\"\".concat(routeURLs.schedule, \"/\").concat(ID_1), styles.scheduleOverlay);\n                });\n                bookButton.replaceWith(clonedButton);\n            }\n        });\n        (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(waitClientList, 500);\n    }\n    else {\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey waiting to update book link\");\n        (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(waitClientList, 500);\n    }\n}\nfunction setGeneralTab() {\n    var generalTab = document.querySelector('[data-testid=\"activetab-general\"]');\n    (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey general tab is\", generalTab);\n    generalTab &&\n        generalTab.addEventListener(\"click\", function () {\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey clicked general tab\", generalTab);\n            waitAppointmentSidebar();\n            (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(function () {\n                (0,_helpers_calendar_index__WEBPACK_IMPORTED_MODULE_4__.setAppointmentCollapse)();\n            }, 600);\n        }, false);\n}\nfunction waitCarePlan() {\n    var $ = initJQuery();\n    if (!$) {\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey waiting for jquery to load\");\n        (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(waitCarePlan, 200);\n    }\n    else {\n        // Check if the care plan tab contents have loaded\n        var cpTabContents_1 = $(\".cp-tab-contents\");\n        if (cpTabContents_1.length > 0) {\n            // Handle edge case: clicking on careplan tab multiple times\n            var careplanTabBtn = $('a[data-testid=\"careplans-tab-btn\"]');\n            careplanTabBtn.off(\"click\").on(\"click\", function () { return handleCarePlanTabClick(cpTabContents_1, patientNumber, healthieAPIKey); });\n            var parent_2 = cpTabContents_1.eq(0);\n            // Add a div with the text \"Loading Careplan...\"\n            var loadingDiv = $(\"<div>\").addClass(\"vori-loading-message\").text(\"Loading Careplan...\").css({\n                textAlign: \"center\",\n                margin: \"1.8rem\",\n                fontSize: \"18px\",\n            });\n            var loadingDivExists = $(\".vori-loading-message\");\n            if (!loadingDivExists.length) {\n                parent_2.append(loadingDiv);\n            }\n            patientNumber = location.href.split(\"/\")[location.href.split(\"/\").length - 2];\n            var iframe_1 = (0,_helpers_ui_index__WEBPACK_IMPORTED_MODULE_3__.generateIframe)(\"\".concat(patientNumber, \"/\").concat(routeURLs.careplan), {\n                className: \"cp-tab-contents\",\n            });\n            (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(function () {\n                parent_2.empty();\n                parent_2.append(iframe_1);\n            }, 50);\n            carePlanLoopLock = carePlanLoopLock + 1;\n            // Remove styling of Healthie tab element\n            // document.getElementsByClassName(\"column is-12 is-12-mobile\")[0].style = \"\";\n        }\n        else {\n            // Wait for content load\n            (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey waiting for careplan tab\");\n            (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(waitCarePlan, 200);\n        }\n    }\n}\nfunction waitGoalTab() {\n    // Check to see if the care plan tab contents has loaded\n    var goalsTabBtn = document.querySelector('[data-testid=\"goals-tab-btn\"]');\n    if (goalsTabBtn && goalsTabBtn.parentElement) {\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey found goals tab\");\n        goalsTabBtn.parentElement.remove();\n    }\n    else {\n        // Wait for content load\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey waiting goals tab\");\n        (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(waitGoalTab, 200);\n    }\n}\nfunction waitInfo() {\n    var infoButton = document.getElementsByClassName(\"right-menu-trigger is-hidden-mobile\")[0];\n    if (infoButton) {\n        (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(function () {\n            setGeneralTab();\n            (0,_helpers_calendar_index__WEBPACK_IMPORTED_MODULE_4__.setAppointmentCollapse)();\n        }, 600);\n        infoButton.addEventListener(\"click\", function () {\n            (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(function () {\n                var appointmentWindow = document.querySelector('[data-testid=\"cp-section-appointments\"]');\n                (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"tampermonkey info clicked\", appointmentWindow);\n                setGeneralTab();\n                (0,_helpers_calendar_index__WEBPACK_IMPORTED_MODULE_4__.setAppointmentCollapse)();\n                appointmentWindow && waitAppointmentSidebar();\n            }, 500);\n        }, false);\n    }\n    else {\n        (0,_helpers_timeoutHelpers__WEBPACK_IMPORTED_MODULE_1__.createTimeout)(waitInfo, 500);\n    }\n}\nfunction waitForAddPatientButton() {\n    var $ = initJQuery();\n    if ($(\".add-client-container button:contains('Add Client')\").length > 0) {\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"Add Client Button found\");\n        (0,_helpers_ui_index__WEBPACK_IMPORTED_MODULE_3__.createPatientDialogIframe)();\n    }\n    else {\n        (0,_utils_index__WEBPACK_IMPORTED_MODULE_0__.debugLog)(\"Waiting for 'Add Client' button\");\n        setTimeout(waitForAddPatientButton, 200);\n    }\n}\n\n\n\n//# sourceURL=webpack://typescript-script/./init/index.ts?");

/***/ }),

/***/ "./utils/index.ts":
/*!************************!*\
  !*** ./utils/index.ts ***!
  \************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   convertToCSSProperty: () => (/* binding */ convertToCSSProperty),\n/* harmony export */   debugLog: () => (/* binding */ debugLog),\n/* harmony export */   waitForMishaMessages: () => (/* binding */ waitForMishaMessages)\n/* harmony export */ });\n/* harmony import */ var _api_index__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../api/index */ \"./api/index.ts\");\n/* harmony import */ var _init_index__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../init/index */ \"./init/index.ts\");\n/* harmony import */ var _helpers_ui_index__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ../helpers/ui/index */ \"./helpers/ui/index.ts\");\n\n\n\nvar isStagingEnv = location.href.includes(\"securestaging\") ? true : false;\nvar healthieURL = isStagingEnv ? \"securestaging.gethealthie.com\" : \"vorihealth.gethealthie.com\";\nvar debug = false;\nvar patientNumber = \"\";\nvar isEmailVerified = true;\nvar isPhoneNumberVerified = true;\nvar isLoadingEmailPhone = true;\nfunction convertToCSSProperty(jsProperty) {\n    return jsProperty.replace(/[A-Z]/g, function (match) { return \"-\".concat(match.toLowerCase()); });\n}\nfunction debugLog() {\n    var _a;\n    var messages = [];\n    for (var _i = 0; _i < arguments.length; _i++) {\n        messages[_i] = arguments[_i];\n    }\n    if (isStagingEnv || debug) {\n        (_a = unsafeWindow.console).log.apply(_a, messages);\n    }\n}\nfunction waitForMishaMessages() {\n    window.onmessage = function (event) {\n        debugLog(\"tampermonkey received misha event\", event);\n        //check event to see if is care plan message\n        if (event.data.tmInput !== undefined && patientNumber !== \"\") {\n            // let's get all user goals and delete them before adding new ones\n            var getGoalQuery = \"query {\\n          goals(user_id: \\\"\".concat(patientNumber, \"\\\", per_page: 100) {\\n            id,\\n            name\\n          }\\n        }\\n        \");\n            var getGoalPayload = JSON.stringify({ query: getGoalQuery });\n            (0,_api_index__WEBPACK_IMPORTED_MODULE_0__.healthieGQL)(getGoalPayload).then(function (response) {\n                var allGoals = response.data.goals;\n                debugLog(\"tampermonkey all goals\", response);\n                // delete all goals\n                allGoals.forEach(function (goal) {\n                    var deleteGoalQuery = \"mutation {\\n              deleteGoal(input: {id: \\\"\".concat(goal.id, \"\\\"}) {\\n                goal {\\n                  id\\n                }\\n                messages {\\n                  field\\n                  message\\n                }\\n              }\\n            }\\n            \");\n                    var deleteGoalPayload = JSON.stringify({\n                        query: deleteGoalQuery,\n                    });\n                    (0,_api_index__WEBPACK_IMPORTED_MODULE_0__.healthieGQL)(deleteGoalPayload).then(function (response) {\n                        debugLog(\"tampermonkey deleted goal\", response);\n                    });\n                });\n                var carePlan = event.data.tmInput;\n                debugLog(\"tampermonkey message posted \".concat(patientNumber, \" care plan status \").concat(JSON.stringify(carePlan)));\n                var goal = carePlan.goal.title;\n                debugLog(\"tampermokey goal title \", goal);\n                var milestones = carePlan.milestones;\n                //create goal for each milestone\n                milestones.forEach(function (element) {\n                    debugLog(\"tampermonkey milestone inserted\", element);\n                    var milestoneTitle = element.title;\n                    if (element.isVisible) {\n                        var query_1 = \"mutation {\\n                createGoal(input: {\\n                  name: \\\"\".concat(milestoneTitle, \"\\\",\\n                  user_id: \\\"\").concat(patientNumber, \"\\\",\\n                  repeat: \\\"Once\\\"\\n                }) {\\n                  goal {\\n                    id\\n                  }\\n                  messages {\\n                    field\\n                    message\\n                  }\\n                }\\n              }\\n              \");\n                        var payload_1 = JSON.stringify({ query: query_1 });\n                        (0,_api_index__WEBPACK_IMPORTED_MODULE_0__.healthieGQL)(payload_1);\n                    }\n                });\n                //create goal for what matters to me\n                var query = \"mutation {\\n            createGoal(input: {\\n              name: \\\"\".concat(goal, \"\\\",\\n              user_id: \\\"\").concat(patientNumber, \"\\\",\\n              repeat: \\\"Once\\\"\\n            }) {\\n              goal {\\n                id\\n              }\\n              messages {\\n                field\\n                message\\n              }\\n            }\\n          }\\n          \");\n                var payload = JSON.stringify({ query: query });\n                (0,_api_index__WEBPACK_IMPORTED_MODULE_0__.healthieGQL)(payload);\n                var tasks = carePlan.tasks.tasks;\n                debugLog(\"tampermonkey tasks are \", tasks);\n                //create goal for each task\n                tasks.forEach(function (element) {\n                    debugLog(\"tampermonkey task is \", element);\n                    if (element.contentfulId == \"6nJFhYE6FJcnWLc3r1KHPR\") {\n                        //motion guide task\n                        debugLog(\"tampermonkey motion guide assigned\");\n                        //create goal for each assigned exercise\n                        element.items[0].exercises.forEach(function (element) {\n                            debugLog(\"tampermonkey\", element);\n                            var name = element.contentfulEntityId + \" - \" + element.side;\n                            var query = \"mutation {\\n                  createGoal(input: {\\n                    name: \\\"\".concat(name, \"\\\",\\n                    user_id: \\\"\").concat(patientNumber, \"\\\",\\n                    repeat: \\\"Daily\\\"\\n                  }) {\\n                    goal {\\n                      id\\n                    }\\n                    messages {\\n                      field\\n                      message\\n                    }\\n                  }\\n                }\\n                \");\n                            var payload = JSON.stringify({ query: query });\n                            (0,_api_index__WEBPACK_IMPORTED_MODULE_0__.healthieGQL)(payload);\n                        });\n                    }\n                    else {\n                        if (element.isVisible) {\n                            //regular task\n                            debugLog(\"tampermonkey regular task assigned\");\n                            var query_2 = \"mutation {\\n                  createGoal(input: {\\n                    name: \\\"\".concat(element.title, \"\\\",\\n                    user_id: \\\"\").concat(patientNumber, \"\\\",\\n                    repeat: \\\"Daily\\\"\\n                  }) {\\n                    goal {\\n                      id\\n                    }\\n                    messages {\\n                      field\\n                      message\\n                    }\\n                  }\\n                }\\n                \");\n                            var payload_2 = JSON.stringify({ query: query_2 });\n                            (0,_api_index__WEBPACK_IMPORTED_MODULE_0__.healthieGQL)(payload_2);\n                        }\n                    }\n                });\n            });\n        }\n        if (event.data.reschedule !== undefined || event.data.reload !== undefined) {\n            (0,_init_index__WEBPACK_IMPORTED_MODULE_1__.rescheduleAppointment)(event.data.reschedule);\n        }\n        if (event.data.reload !== undefined) {\n            window.location.reload();\n        }\n        if (event.data.closeWindow !== undefined) {\n            (0,_helpers_ui_index__WEBPACK_IMPORTED_MODULE_2__.hideOverlay)();\n        }\n        if (event.data.patientProfile !== undefined) {\n            debugLog(\"tampermonkey navigating to patient profile\", event.data.patientProfile);\n            window.open(\"https://\".concat(healthieURL, \"/users/\").concat(event.data.patientProfile), \"_top\");\n        }\n        if (event.data.isEmailVerified !== undefined) {\n            debugLog(\"tampermonkey is email verified\", event.data.isEmailVerified);\n            isEmailVerified = event.data.isEmailVerified;\n            !isEmailVerified && (0,_init_index__WEBPACK_IMPORTED_MODULE_1__.verifyEmailPhoneButtons)(true);\n        }\n        if (event.data.isPhoneNumberVerified !== undefined) {\n            debugLog(\"tampermonkey is phone verified\", event.data.isPhoneNumberVerified);\n            isPhoneNumberVerified = event.data.isPhoneNumberVerified;\n            !isPhoneNumberVerified && (0,_init_index__WEBPACK_IMPORTED_MODULE_1__.verifyEmailPhoneButtons)(false);\n        }\n        if (event.data.loading !== undefined) {\n            debugLog(\"tampermonkey loading\", event.data.loading);\n            isLoadingEmailPhone = event.data.loading ? true : false;\n        }\n    };\n}\n\n\n\n//# sourceURL=webpack://typescript-script/./utils/index.ts?");

/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId](module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/define property getters */
/******/ 	(() => {
/******/ 		// define getter functions for harmony exports
/******/ 		__webpack_require__.d = (exports, definition) => {
/******/ 			for(var key in definition) {
/******/ 				if(__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
/******/ 					Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 				}
/******/ 			}
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/hasOwnProperty shorthand */
/******/ 	(() => {
/******/ 		__webpack_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop))
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/make namespace object */
/******/ 	(() => {
/******/ 		// define __esModule on exports
/******/ 		__webpack_require__.r = (exports) => {
/******/ 			if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
/******/ 				Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 			}
/******/ 			Object.defineProperty(exports, '__esModule', { value: true });
/******/ 		};
/******/ 	})();
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module can't be inlined because the eval devtool is used.
/******/ 	var __webpack_exports__ = __webpack_require__("./index.ts");
/******/ 	
/******/ })()
;
>>>>>>> CAX-72-TM-typescript-refactor
