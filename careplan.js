// ==UserScript==
// @name         Healthie Care Plan Integration
// @namespace    http://tampermonkey.net/
// @version      0.70
// @description  Injecting care plan components into Healthie
// @author       Don, Tonye
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
let healthieURL = isStagingEnv
  ? "securestaging.gethealthie.com"
  : "vorihealth.gethealthie.com";
let healthieAPIKey = GM_getValue(
  isStagingEnv ? "healthieStagingApiKey" : "healthieApiKey",
  ""
);
let auth = `Basic ${healthieAPIKey}`;
const urlValidation = {
  apiKeys: /\/settings\/api_keys$/,
  appointments: /\/appointments|\/organization|\/providers\//,
  appointmentsHome: /^https?:\/\/[^/]+\.com(\/overview|\/)?$/,
  appointmentsProfile:
    /^https?:\/\/([^\/]+)?\.?([^\/]+)\/users\/\d+(?:\/(?:Overview))?\/?$/,
  membership:
    /^https?:\/\/([^\/]+)?\.?([^\/]+)\/users\/\d+(?:\/(?:Overview|Actions))?\/?$/,
  verifyEmailPhone:
    /^https?:\/\/([^\/]+)?\.?([^\/]+)\/users\/\d+(?:\/(?:Actions))\/?$/,
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
  let field = isEmail
    ? document.getElementById("email")
    : document.getElementById("phone_number");
  let button = isEmail
    ? document.getElementById("verify-email-button")
    : document.getElementById("verify-phone-button");
  if (field.value != "") {
    patientNumber =
      location.href.split("/")[location.href.split("/").length - 2];
    let verifyOverlayURL = routeURLs.otpVerify + `?id=${patientNumber}`;
    verifyOverlayURL += isEmail
      ? `&email=${field.value}`
      : `&phone=${field.value}`;
    if (!button && field) {
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
