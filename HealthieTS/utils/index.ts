import { healthieGQL} from '../api/index';
import { initDatadog, rescheduleAppointment, verifyEmailPhoneButtons} from '../init/index';
import { hideOverlay} from '../helpers/ui/index';

const isStagingEnv: boolean = location.href.includes("securestaging") ? true : false;
declare var unsafeWindow: Window & typeof globalThis & { [key: string]: any };
let healthieURL: string = isStagingEnv ? "securestaging.gethealthie.com" : "vorihealth.gethealthie.com";
let debug: boolean = false;
let patientNumber: string = "";
let isEmailVerified: boolean = true;
let isPhoneNumberVerified: boolean = true;
let isLoadingEmailPhone: boolean = true;
function convertToCSSProperty(jsProperty: string): string {
    return jsProperty.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
  }

  function debugLog(...messages: any[]): void {
    if (isStagingEnv || debug) {
      unsafeWindow.console.log(...messages);
    }
  }

  function waitForMishaMessages(): void {
    window.onmessage = function (event: MessageEvent): void {
      debugLog("tampermonkey received misha event", event);
      //check event to see if is care plan message
      if (event.data.tmInput !== undefined && patientNumber !== "") {
        // let's get all user goals and delete them before adding new ones
        const getGoalQuery: string = `query {
          goals(user_id: "${patientNumber}", per_page: 100) {
            id,
            name
          }
        }
        `;
        const getGoalPayload: string = JSON.stringify({ query: getGoalQuery });
        healthieGQL(getGoalPayload).then((response: any) => {
          const allGoals: any[] = response.data.goals;
          debugLog("tampermonkey all goals", response);
  
          // delete all goals
          allGoals.forEach((goal: any) => {
            const deleteGoalQuery: string = `mutation {
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
            const deleteGoalPayload: string = JSON.stringify({
              query: deleteGoalQuery,
            });
            healthieGQL(deleteGoalPayload).then((response: any) => {
              debugLog("tampermonkey deleted goal", response);
            });
          });
  
          const carePlan: any = event.data.tmInput;
          debugLog(`tampermonkey message posted ${patientNumber} care plan status ${JSON.stringify(carePlan)}`);
          const goal: string = carePlan.goal.title;
          debugLog("tampermokey goal title ", goal);
  
          const milestones: any[] = carePlan.milestones;
          //create goal for each milestone
          milestones.forEach((element: any) => {
            debugLog("tampermonkey milestone inserted", element);
            const milestoneTitle: string = element.title;
            if (element.isVisible) {
              const query: string = `mutation {
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
              const payload: string = JSON.stringify({ query });
              healthieGQL(payload);
            }
          });
  
          //create goal for what matters to me
          const query: string = `mutation {
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
          const payload: string = JSON.stringify({ query });
          healthieGQL(payload);
  
          const tasks: any[] = carePlan.tasks.tasks;
          debugLog("tampermonkey tasks are ", tasks);
          //create goal for each task
          tasks.forEach((element: any) => {
            debugLog("tampermonkey task is ", element);
            if (element.contentfulId == "6nJFhYE6FJcnWLc3r1KHPR") {
              //motion guide task
              debugLog("tampermonkey motion guide assigned");
              //create goal for each assigned exercise
              element.items[0].exercises.forEach((element: any) => {
                debugLog("tampermonkey", element);
                const name: string = element.contentfulEntityId + " - " + element.side;
                const query: string = `mutation {
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
                const payload: string = JSON.stringify({ query });
                healthieGQL(payload);
              });
            } else {
              if (element.isVisible) {
                //regular task
                debugLog("tampermonkey regular task assigned");
                const query: string = `mutation {
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
                const payload: string = JSON.stringify({ query });
                healthieGQL(payload);
              }
            }
          });
        });
      }
      if (event.data.reschedule !== undefined || event.data.reload !== undefined) {
        rescheduleAppointment(event.data.reschedule);
      }
      if (event.data.reload !== undefined) {
        window.location.reload();
      }
      if (event.data.closeWindow !== undefined) {
        hideOverlay();
      }
      if (event.data.patientProfile !== undefined) {
        debugLog("tampermonkey navigating to patient profile", event.data.patientProfile);
        window.open(`https://${healthieURL}/users/${event.data.patientProfile}`, "_top");
      }
      if (event.data.isEmailVerified !== undefined) {
        debugLog("tampermonkey is email verified", event.data.isEmailVerified);
        isEmailVerified = event.data.isEmailVerified;
        !isEmailVerified && verifyEmailPhoneButtons(true);
      }
      if (event.data.isPhoneNumberVerified !== undefined) {
        debugLog("tampermonkey is phone verified", event.data.isPhoneNumberVerified);
        isPhoneNumberVerified = event.data.isPhoneNumberVerified;
        !isPhoneNumberVerified && verifyEmailPhoneButtons(false);
      }
      if (event.data.loading !== undefined) {
        debugLog("tampermonkey loading", event.data.loading);
        isLoadingEmailPhone = event.data.loading ? true : false;
      }
      if (event.data.datadog !== undefined) {
        debugLog("tampermonkey datadog token received");
        initDatadog();
      }
    };
  }

  export { convertToCSSProperty, debugLog, waitForMishaMessages };
