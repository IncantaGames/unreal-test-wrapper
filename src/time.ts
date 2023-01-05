import moment from "moment";
import { Colors, ColoredText } from "./colors";

export function timeText(
  timeStart: number,
  timeStop: number,
  ignoreSpeed: boolean = false
) {
  const diff = timeStop - timeStart;

  let speed = Colors.Fast;

  if (!ignoreSpeed) {
    if (diff > 1000) {
      speed = Colors.Slow;
    } else if (diff > 200) {
      speed = Colors.Medium;
    }
  }

  return ColoredText(speed, `(${Math.trunc(diff)}ms)`);
}

export function lineTimestamp(line: string) {
  const timestamp = line.substring(1, 24);
  const d = moment(timestamp, "YYYY.MM.DD-HH.mm.ss:SSS");
  return d.valueOf();
}
