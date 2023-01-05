#!/usr/bin/env node

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import assert from "assert";
import { performance } from "perf_hooks";
import os from "os";
import { Sema } from "async-sema";
import Registry from "winreg";
import ini from "ini";
import { Command } from "commander";
import { Colors, ColoredText } from "./colors";
import { lineTimestamp, timeText } from "./time";

enum UnrealBuildConfiguration {
  Debug = "Debug",
  DebugGame = "DebugGame",
  Development = "Development",
  Test = "Test",
  Shipping = "Shipping",
}

(async () => {
  const symbols = (await import("log-symbols")).default;
  const ora = (await import("ora")).default;

  const packageJsonFile = path.join(__dirname, "..", "package.json");
  const packageJson = JSON.parse(
    await fs.promises.readFile(packageJsonFile, { encoding: "utf-8" })
  );
  const program = new Command();

  program
    .name("utw")
    .description(
      "Unreal Test Wrapper is a script that bootstraps and beautifies Unreal tests. Call from the directory"
    )
    .version(packageJson.version)
    .argument("<test-pattern>", "The test pattern to use for Unreal Automation")
    .option(
      "-b --build-configuration <build-configuration>",
      `The build configuration to use (${Object.values(
        UnrealBuildConfiguration
      ).join(", ")}; default: ${UnrealBuildConfiguration.Development})`,
      UnrealBuildConfiguration.Development
    )
    .option(
      "--engine-dir <engine-dir>",
      "Path to the base of the Unreal Engine installation to use."
    )
    .option("--no-color", "Disable colorized output");

  await program.parseAsync();

  const testPattern = program.args[0];

  const opts = program.opts();
  const noColor = opts.noColor;

  console.log();

  let engineDir: string;
  let unrealExe: string;

  const dirContents = await fs.promises.readdir(process.cwd());
  const uprojectFiles = dirContents.filter((f) => f.endsWith(".uproject"));

  assert.equal(
    uprojectFiles.length,
    1,
    "Run in a directory that only has one .uproject file"
  );

  const uprojectFilePath = path.join(process.cwd(), uprojectFiles[0]);

  if (opts.engineDir) {
    assert(
      fs.existsSync(opts.engineDir),
      `Engine directory ${opts.engineDir} does not exist`
    );
    engineDir = opts.engineDir;
  } else {
    const uprojectStr = await fs.promises.readFile(uprojectFilePath, {
      encoding: "utf-8",
    });
    const uproject = JSON.parse(uprojectStr);

    assert(
      typeof uproject.EngineAssociation === "string" &&
        uproject.EngineAssociation !== "",
      `${uprojectFiles[0]} doesn't have a valid EngineAssociation value`
    );

    switch (os.type()) {
      case "Windows_NT": {
        const key = new Registry({
          hive: Registry.HKCU,
          key: "\\Software\\Epic Games\\Unreal Engine\\Builds",
        });
        engineDir = await new Promise<string>((resolve, reject) => {
          key.get(uproject.EngineAssociation, (error, result) => {
            if (error) {
              reject(
                `Could not find the installed engine version ${uproject.EngineAssociation}`
              );
            } else {
              resolve(result.value);
            }
          });
        });
        break;
      }
      case "Darwin": {
        if (process.env.HOME) {
          const configFilePath = path.join(
            process.env.HOME,
            "Library",
            "Application Support",
            "Epic",
            "UnrealEngine",
            "Install.ini"
          );
          const configFile = await fs.promises.readFile(configFilePath, {
            encoding: "utf-8",
          });
          const config = ini.parse(configFile);
          if (
            config.Installations &&
            config.Installations[uproject.EngineAssociation]
          ) {
            engineDir = config.Installations[uproject.EngineAssociation];
          } else {
            throw new Error(
              `Could not find the installed engine version ${uproject.EngineAssociation}`
            );
          }
        } else {
          throw new Error(
            `Could not find the installed engine version ${uproject.EngineAssociation}`
          );
        }
        break;
      }
      case "Linux":
      default: {
        throw new Error("Linux isn't supported yet");
      }
    }
  }

  let binaryLabel;
  let binaryExtension = "";
  switch (os.type()) {
    case "Windows_NT": {
      binaryLabel = "Win64";
      binaryExtension = ".exe";
      break;
    }
    case "Darwin": {
      binaryLabel = "Mac";
      break;
    }
    case "Linux": {
      binaryLabel = "Linux";
      break;
    }
    default: {
      throw new Error("Invalid OS");
    }
  }

  const buildConfig: UnrealBuildConfiguration = opts.buildConfiguration;

  const suffix =
    buildConfig === UnrealBuildConfiguration.Development
      ? `${binaryExtension}`
      : `-${binaryLabel}-${opts.buildConfiguration}${binaryExtension}`;
  const ue4Editor = path.join(
    engineDir,
    "Engine",
    "Binaries",
    binaryLabel,
    `UE4Editor${suffix}`
  );
  if (fs.existsSync(ue4Editor)) {
    unrealExe = ue4Editor;
  } else {
    const ue5Editor = path.join(
      engineDir,
      "Engine",
      "Binaries",
      binaryLabel,
      `UnrealEditor${suffix}`
    );
    if (fs.existsSync(ue5Editor)) {
      unrealExe = ue5Editor;
    } else {
      throw new Error(
        `Could not find UE4Editor${suffix} or UnrealEditor${suffix} for engine version located at ${engineDir}`
      );
    }
  }

  let spinner = ora({
    text: "Starting Unreal",
  }).start();
  let timeStart = performance.now();

  const args = [
    uprojectFilePath,
    `-ExecCmds=Automation RunTests ${testPattern};Quit`,
    "-stdout",
    "-FullStdOutLogOutput",
    "-Unattended",
    "-NoPause",
    "-NoSplash",
    "-NoSound",
    "-NullRHI",
  ];

  const p = spawn(unrealExe, args, {
    stdio: "pipe",
  });

  const lock = new Sema(1);

  let numTests: number = 0;

  let nextLine: string = "";

  let linesToProcess: string[] = [];

  let currentTestPath: string[] = [];

  let timeStartTotal: number;
  let passingTests: number = 0;
  let failingTests: number = 0;

  function indent() {
    return "  ".repeat(1 + currentTestPath.length);
  }

  function processPath(testPath: string[]) {
    if (currentTestPath.length === 0) {
      for (let j = 0; j < testPath.length; j++) {
        console.log("  ".repeat(j + 1) + testPath[j]);
      }
    }

    for (let i = 0; i < currentTestPath.length; i++) {
      const oldPathPart = currentTestPath[i];

      if (testPath.length <= i) {
        break;
      }

      const newPathPart = testPath[i];

      if (oldPathPart !== newPathPart) {
        // here's the difference, be sure to print out the rest
        for (let j = i; j < testPath.length; j++) {
          console.log("  ".repeat(j + 1) + testPath[j]);
        }
        break;
      }
    }

    currentTestPath = testPath;
  }

  async function processLines() {
    await lock.acquire();

    for (const line of linesToProcess) {
      const lineTime = lineTimestamp(line);

      if (numTests > 0) {
        // eslint-disable-next-line no-control-regex
        const regex = new RegExp("LogAutomationCommandLine: Display: \t(.*)");
        const match = regex.exec(line);
        if (match !== null) {
          const testName = match[1];
          numTests--;
          continue;
        }
      }

      {
        const regex = new RegExp(
          "LogAutomationController: Display: Test Started. Name={(.*)} Path={(.*)}"
        );
        const match = regex.exec(line);
        if (match !== null) {
          const testName = match[1];
          const testPathStr = match[2];
          const testPath = testPathStr.split(".").slice(0, -1);

          timeStart = lineTime;

          processPath(testPath);
          spinner = ora({
            prefixText: indent(),
            text: testName,
          }).start();

          continue;
        }
      }

      {
        const regex = new RegExp(
          "LogAutomationController: (Display|Error): Test Completed. Result={(.*)} Name={(.*)} Path={(.*)}"
        );
        const match = regex.exec(line);
        if (match !== null) {
          const testSuccessful = match[2] === "Success";
          const testName = match[3];
          const testPathStr = match[4];
          const testPath = testPathStr.split(".").slice(0, -1);

          if (testSuccessful) {
            passingTests++;
          } else {
            failingTests++;
          }

          spinner.stopAndPersist({
            symbol: testSuccessful ? symbols.success : symbols.error,
            prefixText: indent(),
            text: `${ColoredText(
              testSuccessful ? Colors.Pass : Colors.Fail,
              testName,
              noColor
            )} ${timeText(timeStart, lineTime, noColor)}`,
          });

          continue;
        }
      }

      {
        if (line.includes("TEST COMPLETE")) {
          console.log();
          console.log(
            ColoredText(
              Colors.Light,
              `  Tests finished ${timeText(timeStartTotal, lineTime, true)}`,
              noColor
            )
          );
        }
      }

      {
        const regex = new RegExp(
          "LogAutomationCommandLine: Error: No automation tests matched"
        );
        const match = regex.exec(line);
        if (match !== null) {
          timeStartTotal = lineTime;
          const timeStop = performance.now();
          spinner.stopAndPersist({
            text: `Unreal Initialized ${timeText(timeStart, timeStop, true)}`,
            symbol: "",
            prefixText: "",
          });
        }
      }

      {
        const regex = new RegExp(
          `LogAutomationCommandLine: Display: Found ([0-9]+) automation tests based on`
        );
        const match = regex.exec(line);
        if (match !== null) {
          timeStartTotal = lineTime;
          const timeStop = performance.now();
          spinner.stopAndPersist({
            text: `Unreal Initialized ${timeText(timeStart, timeStop, true)}`,
            symbol: "",
            prefixText: "",
          });

          numTests = parseInt(match[1], 10);
        }
      }
    }

    linesToProcess = [];

    lock.release();
  }

  p.stdout.on("data", function (data: Buffer) {
    const string = data.toString().replace("\r\n", "\n");
    const lines = string.split("\n");

    if (nextLine !== "") {
      lines[0] = nextLine + lines[0];
      nextLine = "";
    }

    for (let i = 0; i < lines.length - 1; i++) {
      linesToProcess.push(lines[i]);
    }

    if (string.endsWith("\n")) {
      linesToProcess.push(lines[lines.length - 1]);
    } else {
      nextLine = lines[lines.length - 1];
    }

    processLines();
  });

  p.on("close", (code: number) => {
    console.log();

    if (passingTests > 0) {
      const passingText = ColoredText(
        Colors.Green,
        `${passingTests} passing`,
        noColor
      );
      console.log(`  ${passingText}`);
    }

    if (failingTests > 0) {
      const failingText = ColoredText(
        Colors.Fail,
        `${failingTests} failing`,
        noColor
      );
      console.log(`  ${failingText}`);
    }

    if (passingTests === 0 && failingTests === 0) {
      const text = ColoredText(
        Colors.BrightYellow,
        `No tests matched the pattern "${testPattern}"`,
        noColor
      );
      console.log(`  ${text}`);
    }

    console.log();

    process.exitCode = code;
  });
})();
