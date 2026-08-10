import BackgroundService from "react-native-background-actions";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const task = async () => { while (BackgroundService.isRunning()) { await sleep(60000); } };
export async function startKeepAlive(): Promise<string> {
  const options: any = {
    taskName: "logosDelivery", taskTitle: "Logos Delivery", taskDesc: "Shared node running",
    taskIcon: { name: "notification_icon", type: "drawable" }, color: "#0b8f9c",
    linkingURI: "logosdelivery://", foregroundServiceType: ["dataSync"],
  };
  try {
    if (!BackgroundService.isRunning()) await BackgroundService.start(task, options);
    return BackgroundService.isRunning() ? "on" : "start returned but not running";
  } catch (e: any) { return "error: " + String((e && e.message) || e); }
}
