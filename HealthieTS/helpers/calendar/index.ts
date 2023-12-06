import { debugLog } from '../../utils/index';
import { initJQuery, initAddButton, waitAppointmentSidebar } from '../../init/index';
import { createTimeout, clearMyTimeout} from '../../helpers/timeoutHelpers';
import { showOverlay} from '../../helpers/ui/index';
let maxWaitForEvents: number = 500; // comically high number to prevent infinite loop
let maxWaitForInit: number = 500; // comically high number to prevent infinite loop
let maxWaitForCalendarLoad: number = 1500; // comically high number to prevent infinite loop
let initCalTimeout: number | null = null;
let copyComplete: number = -1;
let delayedRun: number = 0;
let debug: boolean = false;
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
function initCalendar(replaceCalendar: boolean): void {
    const $: JQueryStatic = initJQuery();
    if (!$) {
      debugLog(`Tampermonkey jQuery not loaded`);
      initCalTimeout = createTimeout(function () {
        initCalendar(replaceCalendar);
      }, 200);
      return;
    } else {
      if (initCalTimeout !== null) {
        clearMyTimeout(initCalTimeout);
      }
      // clear jquery timeout
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
      let calendar: JQuery | null = null;
      let calendarHeaderBtns: JQuery = $(".rbc-btn-group");
      let activeBtn: JQuery = calendarHeaderBtns.find(".rbc-active");
      let activeTab: JQuery = $(".calendar-tabs").find(".tab-item.active");
      let calendarTab: boolean = activeTab && activeTab.text().toLowerCase().includes("calendar");
      let availabilitiesTab: boolean = activeTab && activeTab.text().toLowerCase().includes("availability");
  
      debugLog(`Tampermonkey copyComplete`, copyComplete);
      // Check if we're on availabilities tab, or if  calendar is loaded and cloned
      if (
        availabilitiesTab ||
        (!replaceCalendar && $(".main-calendar-column").find(".cloned-calendar").length > 0) ||
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
      const overlay: JQuery = $("<div>").addClass("overlay-vori").css({
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
      const calendarLoading: JQuery = $(".day-view.is-loading, .week-view.is-loading, .month-view.is-loading");
      if (calendarLoading.length > 0) {
        debugLog(`Tampermonkey waiting for calendar to load`);
        if ($(".main-calendar-column").find(".overlay-vori").length > 0) {
          $(".main-calendar-column").css({ position: "relative" }).append(overlay);
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
  
      let cssRules: string = `
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
      let cssRuleToCheck: string = ".cloned-calendar";
      let styleElementExists: boolean =
        $("style").filter(function () {
          return $(this).text().indexOf(cssRuleToCheck) !== -1;
        }).length > 0;
      if (!styleElementExists) {
        let styleElement: HTMLStyleElement = document.createElement("style");
        styleElement.appendChild(document.createTextNode(cssRules));
        $("head").append(styleElement);
      }
  
      if (calendarTab) {
        initSidebarCalendar();
        if (activeBtn && (activeBtn.text().toLowerCase().includes("day") || activeBtn.text().toLowerCase().includes("week")) && copyComplete > 0) {
          debugLog(`Tampermonkey calendar is on day or week view`);
          calendar = $(".rbc-time-content");
          let ogCalendar: JQuery = calendar && calendar.first().addClass("og-calendar");
          let clonedCalendar: JQuery = ogCalendar.clone(true);
          clonedCalendar.addClass("cloned-calendar").removeClass("og-calendar").removeAttr("style");
  
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
          debugLog(`Tampermonkey hid original calendar and appended cloned calendar - day/week view`);
        } else if (activeBtn && activeBtn.text().toLowerCase().includes("month") && copyComplete > 0) {
          debugLog(`Tampermonkey calendar is on month view`);
          calendar = $(".rbc-month-view");
          let ogCalendar: JQuery = calendar && calendar.first().addClass("og-calendar");
  
          if (ogCalendar.length > 0) {
            let clonedCalendar: JQuery<HTMLElement> = ogCalendar.clone(true);
            let monthView: NodeListOf<ChildNode> = clonedCalendar[0].childNodes;
            let children: Array<ChildNode> = Array.from(monthView);
            children.forEach((child: ChildNode) => {
              // Check if the child is an HTMLElement before cloning
              if (child instanceof HTMLElement) {
                // Clone the HTMLElement
                let clone = $(child).clone();
                clone.addClass("cloned");
                $(child).replaceWith(clone);
              }
            });
  
            clonedCalendar.addClass("cloned-calendar").removeClass("og-calendar").removeAttr("style");
            debug && showBothCalendars(clonedCalendar, ogCalendar);
            !debug &&
              ogCalendar.css({
                display: "none",
                position: "absolute",
                transform: "translateX(68%)",
              });
            ogCalendar.parent().append(clonedCalendar);
            debugLog(`Tampermonkey hid original calendar and appended cloned calendar - day/week view`);
          }
        }
      }
  
      if (calendar) {
        maxWaitForEvents = 500;
        // Event listeners
        $(".rbc-time-slot, .rbc-day-bg").on("click", function (e: Event) {
          e.stopPropagation();
          showOverlay(`${routeURLs.schedule}`, styles.scheduleOverlay);
        });
        $(".rbc-event.calendar-event").on("click", function (e: Event) {
          e.stopPropagation();
          const dataForValue: string | undefined = $(this).attr("data-for");
          if (dataForValue) {
            const apptUuid: string = dataForValue.split("__")[1].split("_")[0];
            //appointment/appointment id
            showOverlay(`${routeURLs.appointment}/${apptUuid}`, styles.appointmentDetailsOverlay);
          }
        });
        $(".cloned-calendar") && debugLog(`Tampermonkey calendar cloned`);
        copyComplete = -1;
        debugLog(`reset copy complete in initCalendar after cloning`, copyComplete);
        let clonedCalendar: JQuery = $(".cloned-calendar");
        if (clonedCalendar && initCalTimeout !== null) {
          clearMyTimeout(initCalTimeout);
        }
  
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

  function initCalendarHeaderBtns(): void {
    const $: JQueryStatic = initJQuery();
    if (!$) {
      debugLog(`tampermonkey waiting for jquery to load`);
      createTimeout(() => {
        showOverlay("dummy-url", {}); // To do
      }, 200);
      return;
    } else {
      debugLog(`tampermonkey calendar initializing today, prev, next buttons`);
      let activeTab: JQuery<HTMLElement> = $(".calendar-tabs").find(".tab-item.active");
      let availabilitiesTab: boolean = activeTab && activeTab.text().toLowerCase().includes("availability");
  
      if (availabilitiesTab) {
        debugLog(`Tampermonkey calendar is on availability tab - nothing to do here`);
        return;
      }
  
      let dayBtn: HTMLElement = $(".rbc-btn-group").find("button:contains('day')")[0];
      let weekBtn: HTMLElement = $(".rbc-btn-group").find("button:contains('week')")[0];
      let monthBtn: HTMLElement = $(".rbc-btn-group").find("button:contains('month')")[0];
  
      let todayBtn: HTMLElement = $(".rbc-btn-group").find("button:contains('today')")[0];
      let prevBtn: HTMLElement = $(".rbc-btn-group").find("button:contains('<')")[0];
      let nextBtn: HTMLElement = $(".rbc-btn-group").find("button:contains('>')")[0];
  
      if (dayBtn && weekBtn && monthBtn) {
        //add event listeners
        $(dayBtn).on("click", function (e: Event) {
          debugLog(`tampermonkey - clicked on day. Removing cloned calendar...`);
          setTimeout(() => {
            $(".rbc-month-view").remove();
          }, 1000);
        });
        $(weekBtn).on("click", function (e: Event) {
          debugLog(`tampermonkey - clicked on week. Removing cloned calendar...`);
          setTimeout(() => {
            $(".rbc-month-view").remove();
          }, 1000);
        });
        $(monthBtn).on("click", function (e: Event) {
          debugLog(`tampermonkey - clicked on month. Removing cloned calendar...`);
          setTimeout(() => {
            $(".rbc-time-content").remove();
          }, 1000);
        });
      }
  
      if (todayBtn && prevBtn && nextBtn) {
        //add event listeners
        $(todayBtn).on("click", function (e: Event) {
          debugLog(`tampermonkey - clicked on today. Re-initializing calendar...`);
          copyComplete = 1;
          initCalendar(true);
        });
        $(prevBtn).on("click", function (e: Event) {
          debugLog(`tampermonkey - clicked on prev. Re-initializing calendar...`);
          copyComplete = 1;
          initCalendar(true);
        });
        $(nextBtn).on("click", function (e: Event) {
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

  function showBothCalendars(clonedCalendar: JQuery, ogCalendar: JQuery): void {
    clonedCalendar.css({
      position: "absolute",
      transform: "translate(-46%, 35px)",
      left: "0px",
      width: "67%",
      maxWidth: "750px",
      background: "rgb(255, 255, 255)",
    });
    let cssRules: string = `
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
    let cssRuleToCheck: string = ".rbc-time-content.cloned-calendar::before";
    let styleElementExists: boolean =
      $("style").filter(function () {
        return $(this).text().indexOf(cssRuleToCheck) !== -1;
      }).length > 0;
    if (!styleElementExists) {
      let styleElement: HTMLStyleElement = document.createElement("style");
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
      let styleElement: HTMLStyleElement = document.createElement("style");
      styleElement.appendChild(document.createTextNode(cssRules));
      $("head").append(styleElement);
    }
  }

  let calendarInitialized: boolean = false;
function waitCalendar(): void {
  if (!calendarInitialized) {
    initCalendar(false);
    calendarInitialized = true;
  }
}

function initSidebarCalendar(): void {
    let ogSdbrCalendar: JQuery = $(".react-datepicker__month-container");
    let sidebarTimeout: number | null = null;
    if (!ogSdbrCalendar) {
      debugLog(`Tampermonkey waiting for sidebar calendar`);
      sidebarTimeout = createTimeout(initSidebarCalendar, 200);
      return;
    } else {
      debugLog(`Tampermonkey found sidebar calendar`);
      if (sidebarTimeout !== null) {
        clearMyTimeout(sidebarTimeout);
      }
      // create style element to disable pointer events on calendar
      let cssRules: string = `
           .react-datepicker__month-container {
             pointer-events: none;
             user-select: none;
           }
           .react-datepicker__navigation {
             pointer-events: none;
             user-select: none;
           }
         `;
      let cssRuleToCheck: string = ".react-datepicker__month-container";
      let styleElementExists: boolean =
        $("style").filter(function () {
          return $(this).text().indexOf(cssRuleToCheck) !== -1;
        }).length > 0;
      if (!styleElementExists) {
        let styleElement: HTMLStyleElement = document.createElement("style");
        styleElement.appendChild(document.createTextNode(cssRules));
        $("head").append(styleElement);
      }
    }
  }

  function setAppointmentCollapse(): void {
    let appointmentSectionTitle: Element | null = document.querySelector('[data-testid="cp-section-appointments"]');
  
    if (appointmentSectionTitle) {
      appointmentSectionTitle.addEventListener(
        "click",
        function () {
          // Using the non-null assertion operator
          debugLog(`tampermonkey clicked section title`, appointmentSectionTitle!.className);
  
          if (appointmentSectionTitle!.className != "cp-sidebar-expandable-section undefined opened") {
            waitAppointmentSidebar();
          }
        },
        false
      );
    }
  }
  export {
    initCalendar,
    initCalendarHeaderBtns,
    showBothCalendars,
    waitCalendar,
    initSidebarCalendar,
    setAppointmentCollapse
};
