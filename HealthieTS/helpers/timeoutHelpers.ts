let timeoutIds: number[] = [];
function createTimeout(timeoutFunction: () => void, delay: number): number {
    let timeoutId: number = window.setTimeout(() => {
      timeoutFunction();
      timeoutIds = timeoutIds.filter((id) => id !== timeoutId);
    }, delay);
    timeoutIds.push(timeoutId);
    return timeoutId;
  }

  function clearMyTimeout(timeoutId: number): void {
    if (!timeoutId) {
      return;
    }
    window.clearTimeout(timeoutId);
    timeoutIds = timeoutIds.filter((id) => id !== timeoutId);
  }

  export { createTimeout, clearMyTimeout };
