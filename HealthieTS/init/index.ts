import { debugLog, convertToCSSProperty } from '../utils/index';
import { createTimeout} from '../helpers/timeoutHelpers';
import { healthieGQL} from '../api/index';
import { showOverlay, generateIframe, createPatientDialogIframe} from '../helpers/ui/index';
import { setAppointmentCollapse} from '../helpers/calendar/index';

declare function GM_getValue<T>(key: string, defaultValue: T): T;
const isStagingEnv: boolean = location.href.includes("securestaging") ? true : false;
let mishaURL: string = isStagingEnv ? "qa.misha.vori.health/" : "misha.vorihealth.com/";
let healthieAPIKey: string = GM_getValue(isStagingEnv ? "healthieStagingApiKey" : "healthieApiKey", "");
let patientNumber: string = "";
declare var unsafeWindow: Window & typeof globalThis & { [key: string]: any };
let carePlanLoopLock: number = 0;

const routeURLs: { [key: string]: string } = {
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
const styles: { [key: string]: { [key: string]: string } } = {
  scheduleOverlay: {
    display: "inline-block",
    background: "rgb(255, 255, 255)",
    maxWidth: "90vw", // fallback for browsers that don't support svw
    width: "100vw",
    height: "90vh", // fallback for browsers that don't support svh
    overflow: "hidden",
  },
  patientDialogOverlay: {
    display: "inline-block",
    background: "rgb(255, 255, 255)",
    maxWidth: "30vw", // fallback for browsers that don't support svw
    width: "30vw",
    height: "80vh", // fallback for browsers that don't support svh
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
function initAddButton(): void {
    const $: JQueryStatic = initJQuery();
    if (!$) {
      debugLog(`tampermonkey waiting for jquery to load`);
      createTimeout(() => {
        showOverlay("dummy-url", {}); // to do
      }, 200);
      return;
    } else {
      let activeTab: JQuery<HTMLElement> = $(".calendar-tabs").find(".tab-item.active");
      let availabilitiesTab: boolean = activeTab && activeTab.text().toLowerCase().includes("availability");
  
      if (availabilitiesTab) {
        debugLog(`Tampermonkey calendar is on availability tab - nothing to do here`);
        return;
      }
  
      let addAppointmentBtn: HTMLElement = $(".rbc-btn-group.last-btn-group").find("button:contains('Add')")[0];
      if (addAppointmentBtn) {
        let clonedBtn: JQuery<HTMLElement> = $(addAppointmentBtn).clone();
        $(addAppointmentBtn).replaceWith(clonedBtn);
        clonedBtn.on("click", function (e: Event) {
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

  function initBookAppointmentButton(): void {
    if (!$) {
      debugLog(`tampermonkey waiting for jquery to load`);
      createTimeout(() => showOverlay(`${routeURLs.schedule}/${patientNumber}`, styles.scheduleOverlay), 200);
      return;
    } else {
      let bookAppointmentBtn: HTMLElement = $(".insurance-authorization-section").find("button:contains('Book Appointment')")[0];
      if (bookAppointmentBtn) {
        let patientNumber: string = location.href.split("/")[4];
        let clonedBtn: JQuery<HTMLElement> = $(bookAppointmentBtn).clone();
        $(bookAppointmentBtn).replaceWith(clonedBtn);
        clonedBtn.on("click", function (e: Event): void {
          e.stopPropagation();
          showOverlay(`${routeURLs.schedule}/${patientNumber}`, styles.scheduleOverlay);
        });
      } else {
        debugLog(`tampermonkey waiting for book appointment button`);
        createTimeout(initBookAppointmentButton, 200);
      }
    }
  }

  function rescheduleAppointment(appointmentID: string): void {
    showOverlay(`${routeURLs.schedule}/${appointmentID}`, styles.scheduleOverlay);
  }
  function addMembershipAndOnboarding(): void {
    // Get phone icon and related column
    const phoneColumn: Element | null = document.querySelector(".col-12.col-sm-6:has(.telephone-icon)");
  
    if (phoneColumn && phoneColumn.parentNode) {
      const iframeAdded: Element | null = phoneColumn.parentNode.querySelector(".misha-iframe-container");
  
      if (!iframeAdded) {
        // Get the patient number from the URL
        const patientNumber: string = location.href.split("/")[4];
        debugLog(`tampermonkey patient number`, patientNumber);
  
        // Create iframe (generateIframe returns a jQuery object)
        const iframe: JQuery<HTMLElement> = generateIframe(`${routeURLs.patientStatus}/${patientNumber}`, { height: "190px", width: "400px" });
  
        // Check if iframe already exists
        const iframeExists: Element | null = phoneColumn.parentNode.querySelector(".misha-iframe-container");
  
        // Add iframe after phone element if it does not exist
        if (!iframeExists) {
          phoneColumn.parentNode.insertBefore(iframe[0], phoneColumn.nextSibling);
        }
      }
    } else {
      // Wait for content load and retry
      createTimeout(() => {
        addMembershipAndOnboarding();
      }, 200);
    }
  }
  function verifyEmailPhone(): void {
    debugLog(`tampermonkey verifyEmailPhone`);
    let clientInfoPane: HTMLCollectionOf<Element> = document.getElementsByClassName("client-info-pane");
  
    if (clientInfoPane.length > 0) {
      debugLog(`tampermonkey found client info pane`);
      let saveButtons: HTMLCollectionOf<Element> = document.getElementsByClassName(
        "client-profile-submit-button healthie-button primary-button small-button float-right"
      );
      debugLog(`tampermonkey save button`, saveButtons);
  
      if (saveButtons.length > 0) {
        debugLog(`tampermonkey found save button`, saveButtons);
        let saveButton = saveButtons[0] as HTMLElement; // Cast to HTMLElement
        saveButton.onclick = function () {
          createTimeout(() => {
            window.location.reload();
          }, 1000);
        };
      }
  
      let clientInfoPaneObj: Element = clientInfoPane[0];
      // Load invisible iframe for getPatientInfo to determine verification status of phone/email
      patientNumber = location.href.split("/")[location.href.split("/").length - 2];
      let iframe: JQuery<HTMLElement> = generateIframe(`getPatientInfo?id=${patientNumber}`, {
        position: "absolute",
        height: "0px",
        width: "0px",
        border: "0px",
      });
      // Append to document body
      $(clientInfoPaneObj).append(iframe);
    } else {
      createTimeout(() => {
        verifyEmailPhone();
      }, 200);
    }
  }
  function initJQuery(): any {
    let $: any = unsafeWindow.jQuery;
    if ($ && $ !== undefined && typeof $ === "function") {
      return $;
    } else {
      let script: HTMLScriptElement = document.createElement("script");
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
  function verifyEmailPhoneButtons(isEmail: boolean): void {
    let field = isEmail ? (document.getElementById("email") as HTMLInputElement) : (document.getElementById("phone_number") as HTMLInputElement);
  
    if (field && field.value != "") {
      patientNumber = location.href.split("/")[location.href.split("/").length - 2];
      let verifyOverlayURL: string = routeURLs.otpVerify + `?id=${patientNumber}`;
      verifyOverlayURL += isEmail ? `&email=${field.value}` : `&phone=${field.value}`;
  
      let existingButton = isEmail ? document.getElementById("verify-email-button") : document.getElementById("verify-phone-button");
  
      if (!existingButton) {
        // Creating a button style string
        const buttonStyle = {
          background: "#026460",
          color: "white",
          borderRadius: "2px",
        };
        const buttonStyleString = Object.entries(buttonStyle)
          .map(([property, value]) => `${property}: ${value};`)
          .join(" ");
  
        // Create and insert the button
        const button = $("<button>", {
          id: isEmail ? "verify-email-button" : "verify-phone-button",
          text: "Verify",
          style: buttonStyleString,
          type: "button",
          click: function () {
            showOverlay(verifyOverlayURL, styles.otpOverlay);
          },
        });
  
        if (field.parentNode) {
          field.parentNode.insertBefore(button[0], field.nextSibling);
  
          // Adjusting the container style
          if (field.parentElement) {
            let containerStyle = field.parentElement.style;
            containerStyle.display = "flex";
            containerStyle.flexDirection = "row";
          }
        }
      }
    }
  }
  
  function waitAddAppointmentsBtn(): void {
    const $: JQueryStatic = initJQuery();
    if (!$) {
      debugLog(`tampermonkey jquery not loaded`);
      createTimeout(waitAddAppointmentsBtn, 200);
      return;
    } else {
      initAddButton();
    }
  }

  function waitAppointmentSidebar(): void {
    let appointmentWindow: Element | null = document.querySelector('[data-testid="cp-section-appointments"]');
    let goalsTab: Element | null = document.querySelector('[data-testid="tab-goals"]');
    debugLog(`tampermonkey goals tab `, goalsTab);
    goalsTab && goalsTab.remove();
    let actionLinks: Element[] = Array.from(document.getElementsByClassName("healthie-action-link"));
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

  function waitAppointmentsHome(): void {
    const $: any = initJQuery();
    if (!$) {
      createTimeout(waitAppointmentsHome, 200);
      return;
    } else {
      let appointmentWindow: HTMLCollectionOf<Element> = document.getElementsByClassName("provider-home-appointments");
      if (appointmentWindow.length > 0) {
        let appointmentWindowObj: Element = appointmentWindow[0];
        while (appointmentWindowObj.childNodes.length > 1) {
          const lastChild = appointmentWindowObj.lastChild as Element | null;
          if (lastChild) {
            let childClassName: string = lastChild.className;
            debugLog("tampermonkey removing child", childClassName);
            appointmentWindowObj.removeChild(lastChild);
          }
        }
  
        patientNumber = location.href.split("/")[location.href.split("/").length - 1];
  
        const getCurrentUserQuery: string = `query user{
         user(or_current_user: true){
          id
        }
        }`;
  
        const getCurrentUserPayload: string = JSON.stringify({
          query: getCurrentUserQuery,
        });
        healthieGQL(getCurrentUserPayload).then((response: any) => {
          const userId: string = response.data.user.id;
          const iframeSrc: string = `https://${mishaURL}${routeURLs.providerSchedule}/${userId}`;
  
          let existingIframe: Element | null = document.querySelector(`iframe[src="${iframeSrc}"]`);
          if (!existingIframe) {
            const iframe: any = generateIframe(`${routeURLs.providerSchedule}/${userId}`);
            $(appointmentWindowObj).append(iframe);
          }
        });
      } else {
        createTimeout(waitAppointmentsHome, 200);
      }
    }
  }

  function waitAppointmentsProfile(): void {
    const $: JQueryStatic = initJQuery();
    if (!$) {
      debugLog(`tampermonkey jquery not loaded`);
      createTimeout(waitAppointmentsProfile, 200);
      return;
    } else {
      initBookAppointmentButton();
      // check to see if the appointment view contents have loaded
      let appointmentWindow: HTMLElement = $(".insurance-authorization-section div").filter(function (): boolean {
        return $(this).find(".tabs.apps-tabs").length > 0;
      })[0];
      if (appointmentWindow) {
        debugLog(`tampermonkey found appointment view on user profile`);
        $(appointmentWindow).css({ margin: "0", padding: "3px" });
        // get the parent with class .column.is-6 and change the width to 100%
        let parent: JQuery<HTMLElement> = $(appointmentWindow).closest(".column.is-6");
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
        $(".insurance-authorization-section.cp-section.with-dropdown-menus-for-packgs").closest(".column.is-6").css("width", "100%");
  
        // remove all children of appointments section
        while (appointmentWindow.childNodes.length > 0) {
          const lastChild = appointmentWindow.lastChild as Element | null;
          if (lastChild) {
            let childClassName: string = lastChild.className;
            debugLog(`tampermonkey removing child`, childClassName);
            appointmentWindow.removeChild(lastChild);
          }
        }
  
        // example of url to load - https://securestaging.gethealthie.com/users/388687
        // can also be - https://securestaging.gethealthie.com/users/388687/Overview
        const patientID: string = location.href.split("/")[4];
        const iframe: HTMLIFrameElement = generateIframe(`${routeURLs.appointments}/patient/${patientID}`);
        $(appointmentWindow).append(iframe);
      } else {
        // wait for content load
        debugLog(`tampermonkey waiting appointment view on user profile`);
        createTimeout(waitAppointmentsProfile, 200);
      }
    }
  }
  function handleCarePlanTabClick(cpTabContents: JQuery<HTMLElement>, patientNumber: string, healthieAPIKey: string): void {
    if (location.href.includes("all_plans")) {
      if (healthieAPIKey !== "") {
        cpTabContents && cpTabContents.empty();
      }
      waitCarePlan();
    }
  }
  function waitClientList(): void {
    const $: any = initJQuery();
    let bookLinks: Element[] = Array.from(document.querySelectorAll("button")).filter((e) => e.textContent === "Book Session");
    debugLog(`tampermonkey waiting to update book link`, bookLinks);
  
    if (bookLinks.length > 0) {
      bookLinks.forEach((element) => {
        debugLog("tampermonkey book link found", element);
        let parentElement = element.parentElement;
  
        if (parentElement) {
          let ID: string = parentElement.getAttribute("data-testid")?.split("-").pop() ?? "";
          let bookButton: any = $(element);
          let clonedButton: any = bookButton.clone(true);
          clonedButton.on("click", function (e: any) {
            e.stopPropagation();
            showOverlay(`${routeURLs.schedule}/${ID}`, styles.scheduleOverlay);
          });
          bookButton.replaceWith(clonedButton);
        }
      });
      createTimeout(waitClientList, 500);
    } else {
      debugLog(`tampermonkey waiting to update book link`);
      createTimeout(waitClientList, 500);
    }
  }
  function setGeneralTab(): void {
    let generalTab: Element | null = document.querySelector('[data-testid="activetab-general"]');
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
  function waitCarePlan(): void {
    const $: JQueryStatic = initJQuery();
    if (!$) {
      debugLog(`tampermonkey waiting for jquery to load`);
      createTimeout(waitCarePlan, 200);
    } else {
      // Check if the care plan tab contents have loaded
      const cpTabContents: JQuery<HTMLElement> = $(".cp-tab-contents");
      if (cpTabContents.length > 0) {
        // Handle edge case: clicking on careplan tab multiple times
        const careplanTabBtn: JQuery<HTMLElement> = $('a[data-testid="careplans-tab-btn"]');
        careplanTabBtn.off("click").on("click", () => handleCarePlanTabClick(cpTabContents, patientNumber, healthieAPIKey));
  
        const parent: JQuery<HTMLElement> = cpTabContents.eq(0);
        // Add a div with the text "Loading Careplan..."
        const loadingDiv: JQuery<HTMLElement> = $("<div>").addClass("vori-loading-message").text("Loading Careplan...").css({
          textAlign: "center",
          margin: "1.8rem",
          fontSize: "18px",
        });
        const loadingDivExists: JQuery<HTMLElement> = $(".vori-loading-message");
        if (!loadingDivExists.length) {
          parent.append(loadingDiv);
        }
        patientNumber = location.href.split("/")[location.href.split("/").length - 2];
        let iframe: JQuery<HTMLElement> = generateIframe(`${patientNumber}/${routeURLs.careplan}`, {
          className: "cp-tab-contents",
        });
        createTimeout(() => {
          parent.empty();
          parent.append(iframe);
        }, 50);
        carePlanLoopLock = carePlanLoopLock + 1;
        // Remove styling of Healthie tab element
        // document.getElementsByClassName("column is-12 is-12-mobile")[0].style = "";
      } else {
        // Wait for content load
        debugLog(`tampermonkey waiting for careplan tab`);
        createTimeout(waitCarePlan, 200);
      }
    }
  }

  function waitGoalTab(): void {
    // Check to see if the care plan tab contents has loaded
    const goalsTabBtn = document.querySelector('[data-testid="goals-tab-btn"]');
  
    if (goalsTabBtn && goalsTabBtn.parentElement) {
      debugLog(`tampermonkey found goals tab`);
      goalsTabBtn.parentElement.remove();
    } else {
      // Wait for content load
      debugLog(`tampermonkey waiting goals tab`);
      createTimeout(waitGoalTab, 200);
    }
  }

  function waitInfo(): void {
    let infoButton: Element | null = document.getElementsByClassName("right-menu-trigger is-hidden-mobile")[0];
    if (infoButton) {
      createTimeout(function () {
        setGeneralTab();
        setAppointmentCollapse();
      }, 600);
      infoButton.addEventListener(
        "click",
        function () {
          createTimeout(function () {
            let appointmentWindow: Element | null = document.querySelector('[data-testid="cp-section-appointments"]');
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

  function waitForAddPatientButton(): void {
    const $: JQueryStatic = initJQuery();
    if ($(".add-client-container button:contains('Add Client')").length > 0) {
      debugLog("Add Client Button found");
      createPatientDialogIframe();
    } else {
      debugLog("Waiting for 'Add Client' button");
      setTimeout(waitForAddPatientButton, 200);
    }
  }
  
  export {
    addMembershipAndOnboarding,
    initAddButton,
    initJQuery,
    initBookAppointmentButton,
    rescheduleAppointment,
    verifyEmailPhone,
    verifyEmailPhoneButtons,
    waitAddAppointmentsBtn,
    waitAppointmentSidebar,
    waitAppointmentsHome,
    waitAppointmentsProfile,
    waitClientList,
    waitCarePlan,
    waitGoalTab,
    waitInfo,
    waitForAddPatientButton
};
