// Foreground service that keeps the process — and the embedded node — alive when the
// activity is backgrounded. Android kills a plain background process (and its node);
// an ongoing-notification foreground service is what keeps the shared node resident.
import BackgroundService from "react-native-background-actions";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const task = async () => { while (BackgroundService.isRunning()) { await sleep(60000); } };
export async function startKeepAlive() {
  const options: any = {
    taskName: "logosDelivery", taskTitle: "Logos Delivery", taskDesc: "Shared node running",
    taskIcon: { name: "notification_icon", type: "drawable" }, color: "#0b8f9c",
    linkingURI: "logosdelivery://", foregroundServiceType: ["dataSync"],
  };
  try { if (!BackgroundService.isRunning()) await BackgroundService.start(task, options); } catch { /* device may deny */ }
}
