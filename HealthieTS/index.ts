// Import from api folder
import { healthieGQL, isAPIconnected, waitSettingsAPIpage } from './api/index';

// Import from init folder
import {
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
} from './init/index';

// Import from utils folder
import {
    convertToCSSProperty,
    debugLog,
    waitForMishaMessages
} from './utils/index';

// Import from helpers/calendar folder
import {
    initCalendar,
    initCalendarHeaderBtns,
    showBothCalendars,
    waitCalendar,
    initSidebarCalendar,
    setAppointmentCollapse
} from './helpers/calendar/index';

// Import from helpers/ui folder
import {
    addHoverEffect,
    removeHoverEffect,
    showOverlay,
    hideOverlay,
    createPatientDialogIframe,
    generateIframe,
    showInstructions
} from './helpers/ui/index';

// Import from helpers/timeoutHelpers.ts
import { createTimeout, clearMyTimeout } from './helpers/timeoutHelpers';

let previousUrl: string = "";
let carePlanLoopLock: number = 0;
let copyComplete: number = -1;
let timeoutIds: number[] = [];
const urlValidation: { [key: string]: RegExp } = {
    apiKeys: /\/settings\/api_keys$/,
    appointments: /\/appointments|\/organization|\/providers\//,
    appointmentsHome: /^https?:\/\/[^/]+\.com(\/overview|\/)?$/,
    appointmentsProfile: /^https?:\/\/([^\/]+)?\.?([^\/]+)\/users\/\d+(?:\/(?:Overview))?\/?$/,
    membership: /^https?:\/\/([^\/]+)?\.?([^\/]+)\/users\/\d+(?:\/(?:Overview|Actions))?\/?$/,
    verifyEmailPhone: /^https?:\/\/([^\/]+)?\.?([^\/]+)\/users\/\d+(?:\/(?:Actions))\/?$/,
    carePlan: /\/all_plans$/,
    clientList: /\/clients\/active/,
    conversations: /\/conversations/,
    goals: /\/users/,
  };
const observeDOMChanges = (mutations: MutationRecord[], observer: MutationObserver): void => {
    // Handle URL changes
    if (location.href !== previousUrl) {
      previousUrl = location.href;
      carePlanLoopLock = 0;
      debugLog(`tampermonkey URL changed to ${location.href}`);
  
      // Clear all timeouts
      timeoutIds.forEach((id) => clearTimeout(id));
      timeoutIds = [];
  
      waitForMishaMessages();
  
      // URL checks and function calls
      if (urlValidation.carePlan.test(location.href)) {
        debugLog("tampermonkey calls waitCarePlan");
        waitCarePlan();
      }
  
      if (urlValidation.goals.test(location.href)) {
        debugLog("tampermonkey calls waitGoalTab");
        waitGoalTab();
      }
  
      if (urlValidation.appointmentsProfile.test(location.href)) {
        debugLog("tampermonkey calls waitAppointmentsProfile and addMembershipAndOnboarding");
        waitAppointmentsProfile();
      }
  
      if (urlValidation.membership.test(location.href)) {
        addMembershipAndOnboarding();
      }
  
      if (urlValidation.verifyEmailPhone.test(location.href)) {
        verifyEmailPhone();
      }
  
      if (urlValidation.apiKeys.test(location.href)) {
        debugLog("tampermonkey calls waitSettingsAPIpage and showInstructions");
        waitSettingsAPIpage();
        showInstructions();
      }
  
      if (urlValidation.appointments.test(location.href)) {
        debugLog("tampermonkey calls waitAddAppointmentsBtn and waitCalendar");
        waitAddAppointmentsBtn();
        waitCalendar();
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
      if (carePlanLoopLock > 1 && location.href.includes("all_plans")) {
        const iframe = document.querySelector("#MishaFrame.cp-tab-contents");
        if (!iframe) {
          carePlanLoopLock = 0;
          const goalsTab = document.querySelector('[data-testid="goals-tab-btn"]');
          if (goalsTab) {
            const parentDiv = goalsTab.closest("div");
            parentDiv?.remove();
          }
          waitCarePlan();
        }
      }
    }
    const calendarTargetClasses = ["rbc-time-content", "rbc-month-view"];
    const homeTargetClasses = ["provider-home-content"];
    const basicInfoTargetClasses = ["cp-sidebar-expandable-section"];
  
    // Helper function to process NodeList
    const processNodeList = (nodeList: NodeList, targetClasses: string[]) => {
      return Array.from(nodeList).some((node) => {
        if (node instanceof Element) {
          return targetClasses.some((className) => node.classList.contains(className) || node.querySelector(`.${className}`) !== null);
        }
        return false;
      });
    };
  
    for (const mutation of mutations) {
      const { target, addedNodes, removedNodes } = mutation;
  
      // Check for calendar-related changes
      if (
        (target instanceof Element && calendarTargetClasses.some((className) => target.classList.contains(className))) ||
        processNodeList(addedNodes, calendarTargetClasses) ||
        processNodeList(removedNodes, calendarTargetClasses)
      ) {
        observer.disconnect();
        let clonedCalendar = document.querySelector(".cloned-calendar");
        if (!clonedCalendar) copyComplete++;
        debugLog(`increased copy complete in observer`, copyComplete);
        // Replace with the appropriate call if initCalendar expects an argument
        initCalendar(!clonedCalendar);
        observer.observe(document.documentElement, { childList: true, subtree: true });
        break;
      }
  
      // Check for home-related changes
      if (
        (target instanceof Element && homeTargetClasses.some((className) => target.classList.contains(className))) ||
        processNodeList(addedNodes, homeTargetClasses) ||
        processNodeList(removedNodes, homeTargetClasses)
      ) {
        observer.disconnect();
        waitAppointmentsHome();
        observer.observe(document.documentElement, { childList: true, subtree: true });
        break;
      }
  
      // Check for basic info-related changes
      if (
        (target instanceof Element && basicInfoTargetClasses.some((className) => target.classList.contains(className))) ||
        processNodeList(addedNodes, basicInfoTargetClasses) ||
        processNodeList(removedNodes, basicInfoTargetClasses)
      ) {
        observer.disconnect();
        addMembershipAndOnboarding();
        observer.observe(document.documentElement, { childList: true, subtree: true });
        break;
      }
    }
  };
  
  // Configuration for the observer
  const config: MutationObserverInit = { subtree: true, childList: true };
  const observer = new MutationObserver(observeDOMChanges);
  observer.observe(document.documentElement, config);
  
// Export all the necessary functions
export {
    healthieGQL,
    isAPIconnected,
    initAddButton,
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
    waitForAddPatientButton,
    convertToCSSProperty,
    debugLog,
    initJQuery,
    waitForMishaMessages,
    initCalendar,
    initCalendarHeaderBtns,
    showBothCalendars,
    waitCalendar,
    initSidebarCalendar,
    setAppointmentCollapse,
    addHoverEffect,
    removeHoverEffect,
    showOverlay,
    hideOverlay,
    createPatientDialogIframe,
    generateIframe,
    showInstructions,
    createTimeout,
    clearMyTimeout
};
