import { ApiClient, type EndpointData } from "./api-client.js";
import * as ui from "./ui.js";

export interface ResolveOptions {
  all?: boolean;
  endpoint?: string[];
  new?: boolean;
}

export async function resolveEndpoints(
  client: ApiClient,
  options: ResolveOptions,
  targetUrl: string
): Promise<EndpointData[]> {
  if (options.all) {
    const { data: allEndpoints } = await client.listEndpoints();
    if (allEndpoints.length === 0) {
      ui.error("No endpoints found in this account.");
      process.exit(1);
    }
    return allEndpoints;
  }

  if (options.endpoint && options.endpoint.length > 0) {
    const { data: allEndpoints } = await client.listEndpoints();
    const seen = new Set<string>();
    const result: EndpointData[] = [];

    for (const idArg of options.endpoint) {
      if (seen.has(idArg)) {
        ui.warn(`Duplicate endpoint "${idArg}" ignored.`);
        continue;
      }
      seen.add(idArg);

      const found = allEndpoints.find(
        (ep) => ep.id === idArg || ep.custom_id === idArg
      );
      if (!found) {
        ui.error(`Endpoint "${idArg}" not found.`);
        process.exit(1);
      }
      result.push(found);
    }
    return result;
  }

  if (options.new) {
    const name = `Tunnel -> ${targetUrl}`;
    const { data: newEp } = await client.createEndpoint(name);
    ui.success(`Created endpoint "${newEp.name}" (${newEp.id})`);
    return [newEp];
  }

  ui.error("No endpoint option selected.");
  process.exit(1);
}
