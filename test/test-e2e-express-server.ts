import { createConfigComponent } from "@well-known-components/env-config-provider"
import { createLogComponent } from "@well-known-components/logger"
import nodeFetch from "node-fetch"
import { createServerComponent, IFetchComponent } from "../src"
import { createE2ERunner, TestComponents } from "./test-helpers"

let currentPort = 19000

// creates a "mocha-like" describe function to run tests using the test components
export const describeE2E = createE2ERunner({
  async main(components) {},
  initComponents,
})

async function initComponents<C extends object>(): Promise<TestComponents<C>> {
  const logs = createLogComponent()

  const config = createConfigComponent({
    HTTP_SERVER_PORT: currentPort + 1,
    HTTP_SERVER_HOST: "0.0.0.0",
  })

  const protocolHostAndProtocol = `http://${await config.requireString(
    "HTTP_SERVER_HOST"
  )}:${await config.requireNumber("HTTP_SERVER_PORT")}`

  const server = await createServerComponent<C>({ logs, config }, {})

  const fetch: IFetchComponent = {
    async fetch(url, initRequest?) {
      return nodeFetch(protocolHostAndProtocol + url, { ...initRequest })
    },
  }

  return { logs, config, server, fetch }
}