export enum Colors {
  Pass = "90",
  Fail = "31",
  BrightPass = "92",
  BrightFail = "91",
  BrightYellow = "93",
  Pending = "36",
  Suite = "0",
  ErrorTitle = "0",
  ErrorMessage = "31",
  ErrorStack = "90",
  Checkmark = "32",
  Fast = "90",
  Medium = "33",
  Slow = "31",
  Green = "32",
  Light = "90",
  DiffGutter = "90",
  DiffAdded = "32",
  DiffRemoved = "31",
  DiffAddedInline = "30;42",
  DiffRemovedInline = "30;41",
}

export function ColoredText(type: Colors, str: string) {
  return "\u001b[" + type + "m" + str + "\u001b[0m";
}
