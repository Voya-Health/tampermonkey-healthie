import { debugLog, convertToCSSProperty } from '../../utils/index';
import { initJQuery } from '../../init/index';
import { createTimeout} from '../../helpers/timeoutHelpers';

declare function GM_getValue<T>(key: string, defaultValue: T): T;
const isStagingEnv: boolean = location.href.includes("securestaging") ? true : false;
let mishaURL: string = isStagingEnv ? "qa.misha.vori.health/" : "misha.vorihealth.com/";
let healthieAPIKey: string = GM_getValue(isStagingEnv ? "healthieStagingApiKey" : "healthieApiKey", "");
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
function addHoverEffect(apiMsgLink: HTMLAnchorElement): void {
    apiMsgLink.style.textDecoration = "underline";
  }

  function removeHoverEffect(apiMsgLink: HTMLAnchorElement): void {
    apiMsgLink.style.textDecoration = "none";
  }

  function showOverlay(url: string, style: { [key: string]: string } = {}): void {
    const $: JQueryStatic = initJQuery();
    if (!$) {
      debugLog(`tampermonkey waiting for jquery to load`);
      createTimeout(() => showOverlay(url, style), 200);
      return;
    } else {
      hideOverlay();
      // Create overlay element
      let overlay: JQuery<HTMLElement> = $("<div>").addClass("overlay-dialog").css({
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
      $(overlay).on("click", function (): void {
        if ($(".overlay-dialog")) {
          $(".overlay-dialog").remove();
        }
      });
  
      // Create close button element
      let closeButton: JQuery<HTMLElement> = $("<span>").addClass("close-button").html("&times;").css({
        position: "absolute",
        right: "1rem",
        top: "1rem",
        color: "#fff",
        fontSize: "2.5rem",
        cursor: "pointer",
      });
      $(closeButton).on("click", function (): void {
        if ($(".overlay-dialog")) {
          $(".overlay-dialog").remove();
        }
      });
      overlay.append(closeButton);
  
      // Create dialog body element with iframe
      let dialogBody: JQuery<HTMLElement> = $("<div>")
        .addClass("dialog-body")
        .css({
          background: "#fff",
          maxWidth: "max(600px, 60vw)",
          width: "100vw",
          height: "80vh",
          maxheight: "80dvh",
          overflowY: "scroll",
          ...style,
        });
  
      let iframe: HTMLIFrameElement = generateIframe(url, style as { [key: string]: string });
      dialogBody.append(iframe); // Append iframe to dialog body
      overlay.append(dialogBody); // Append dialog body to overlay
      const existingOverlay: JQuery<HTMLElement> = $(".body").find(".overlay-dialog");
  
      if (existingOverlay.length === 0) {
        $("body").append(overlay); // Append overlay to body
        debugLog(`Tampermonkey displayed overlay`);
      }
    }
  }

  function hideOverlay(): void {
    const $: JQueryStatic = initJQuery();
    if (!$) {
      debugLog(`tampermonkey waiting for jquery to load`);
      createTimeout(hideOverlay, 200);
      return;
    } else {
      $(".overlay-dialog").remove();
      debugLog(`Tampermonkey removed overlay`);
    }
  }

  function createPatientDialogIframe(): void {
    const $: JQueryStatic = initJQuery();
    if (!$) {
      debugLog(`tampermonkey waiting for jQuery to load`);
      setTimeout(createPatientDialogIframe, 200);
      return;
    }
    debugLog(`jQuery is loaded, attempting to find 'Add Client' button`);
    let addPatientBtn: JQuery<HTMLElement> = $(".add-client-container button:contains('Add Client')");
  
    if (addPatientBtn.length > 0) {
      debugLog(`'Add Client' button found, proceeding to clone`);
      let clonedBtn: JQuery<HTMLElement> = addPatientBtn.clone();
      addPatientBtn.replaceWith(clonedBtn);
      clonedBtn.on("click", (e: JQuery.Event) => {
        debugLog(`Cloned 'Add Client' button clicked`);
        e.stopPropagation();
        showOverlay(`${routeURLs.createPatientDialog}`, styles.patientDialogOverlay);
      });
    } else {
      debugLog(`'Add Client' button not found, retrying...`);
      setTimeout(createPatientDialogIframe, 200);
    }
  }

  function generateIframe(routeURL: string, options: { [key: string]: string } = {}): any {
    const $: any = initJQuery();
  
    let className: string = "misha-iframe-container";
    const iframeStyles: { [key: string]: string } = {
      height: options.height || "100vh",
      width: options.width || "100%",
      ...options,
    };
    const iframeStyleString: string = Object.entries(iframeStyles)
      .map(([property, value]) => `${convertToCSSProperty(property)}: ${value};`)
      .join(" ");
  
    if (!$) {
      createTimeout(function () {
        generateIframe(routeURL);
      }, 200);
      return;
    } else {
      const iframeElement: any = $("<div>")
        .css({ padding: "0", ...options })
        .addClass(className);
  
      const iframeContent: any = $("<iframe>", {
        id: "MishaFrame",
        title: "Misha iFrame",
        style: iframeStyleString,
        src: `https://${mishaURL}${routeURL}`,
      });
      iframeElement.append(iframeContent);
      return iframeElement;
    }
  }

  function showInstructions(): void {
    if (document.querySelector(".api-keys-wrapper") && document.querySelector(".api-keys-input-button-wrapper")) {
      const apiKeyInputContainer: Element | null = document.querySelector(".api-keys-input-button-wrapper");
  
      if (apiKeyInputContainer && healthieAPIKey === "") {
        const instructions: HTMLParagraphElement = document.createElement("p");
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

  export {
    addHoverEffect,
    removeHoverEffect,
    showOverlay,
    hideOverlay,
    createPatientDialogIframe,
    generateIframe,
    showInstructions
};
