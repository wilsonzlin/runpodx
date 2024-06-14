#!/usr/bin/env node

import { VArray, VString, VStruct } from "@wzlin/valid";
import Semaphore from "@xtjs/lib/Semaphore";
import splitString from "@xtjs/lib/splitString";
import { readFileSync } from "fs";
import { Command } from "sacli";

const req = async (query: string, variables?: any) => {
  const res = await fetch(
    "https://api.runpod.io/graphql?api_key=" +
      encodeURIComponent(process.env["RUNPOD_API_KEY"]!),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    },
  );
  const raw = (await res.json()) as any;
  if (!res.ok || raw["errors"]?.length) {
    throw new Error(
      `Request failed with status ${res.status}: ${JSON.stringify(raw, null, 2)}`,
    );
  }
  return raw["data"];
};

const listTemplates = async () => {
  const {
    myself: { podTemplates },
  } = await req(
    `
      query myself {
        myself {
          podTemplates {
            advancedStart
            containerDiskInGb
            containerRegistryAuthId
            dockerArgs
            earned
            id
            imageName
            isPublic
            isRunpod
            isServerless
            name
            ports
            readme
            runtimeInMin
            startJupyter
            startScript
            startSsh
            volumeInGb
            volumeMountPath
          }
        }
      }
    `,
  );
  return podTemplates.filter((t: any) => !t.isPublic);
};

const cli = Command.new("runpod");

cli.subcommand("list-templates", "List templates").action(async () => {
  console.log(await listTemplates());
});

const readLines = (file: string) =>
  readFileSync(file, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

cli
  .subcommand("launch", "Launch pods")
  .required("template", String, {
    description: "Name of the template to launch",
  })
  .required("count", Number, {
    description: "Number of pods to launch",
  })
  .optional("gpufile", String, {
    description:
      "Path to a file containing a priority list of GPU types to use, one per line (blanks and # ignored), in order of preference",
  })
  .optional("gpu", String, {
    description:
      "GPUs type to use, separated by comma, in order of preference; must be provided if `gpufile` is not",
  })
  .repeated("env", String, {
    description:
      "Additional environment variable to set in the pod, in the form NAME=value, overriding any set via `envfile` if provided",
  })
  .optional("envfile", String, {
    description:
      "Path to a file containing one additional environment variable per line (blanks and # ignored) to set in the pod",
  })
  .boolean("community", {
    description:
      "Use the community cloud (if omitted, secure cloud is used by default)",
  })
  .action(async (args) => {
    const templateId = await listTemplates().then(
      (res) => res.find((t: any) => t.name === args.template)?.id,
    );
    if (!templateId) {
      throw new Error(`Template not found: ${args.template}`);
    }
    const q = new Semaphore(100);
    const env = Object.entries({
      ...(args.envfile
        ? readLines(args.envfile).map((e) => splitString(e, "=", 2))
        : []),
      ...Object.fromEntries(args.env.map((e) => splitString(e, "=", 2))),
    }).map(([key, value]) => ({ key, value }));
    const gpus = args.gpufile
      ? readLines(args.gpufile)
      : args
          .gpu!.split(",")
          .map((g) => g.trim())
          .filter((g) => g);
    await Promise.all(
      Array.from({ length: args.count }, () =>
        q.add(async () => {
          // NOTE: `gpuTypeIdList` is intentionally ordered in order of performance-per-dollar, do not sort alphabetically.
          await req(
            `
              mutation {
                podFindAndDeployOnDemand(
                  input: {
                    cloudType: ${args.community ? "COMMUNITY" : "SECURE"}
                    containerDiskInGb: 0
                    dockerArgs: ""
                    env: ${JSON.stringify(env)}
                    gpuCount: 1
                    gpuTypeIdList: ${JSON.stringify(gpus)}
                    minMemoryInGb: 4
                    minVcpuCount: 1
                    name: ${JSON.stringify(args.template)}
                    startJupyter: false
                    startSsh: true
                    supportPublicIp: true
                    templateId: "${templateId}"
                    volumeInGb: 0
                  }
                ) {
                  id
                }
              }
            `,
          );
        }),
      ),
    );
  });

cli.subcommand("terminate", "Terminate pods").action(async () => {
  const raw = await req(
    `
      query myself {
        myself {
          pods {
            id
          }
        }
      }
    `,
  );
  const pods = new VStruct({
    myself: new VStruct({
      pods: new VArray(
        new VStruct({
          id: new VString(),
        }),
      ),
    }),
  }).parseRoot(raw).myself.pods;
  console.log("Terminating", pods.length, "pods");
  const q = new Semaphore(100);
  await Promise.all(
    pods.map((p) =>
      q.add(async () => {
        await req(
          `
            mutation podTerminate($input: PodTerminateInput!) {
              podTerminate(input: $input)
            }
          `,
          {
            input: {
              podId: p.id,
            },
          },
        );
      }),
    ),
  );
});

cli.eval(process.argv.slice(2));
