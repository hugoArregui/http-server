import cors from "cors"
import compression from "compression"
import express from "express"
import type {
  IBaseComponent,
  IHttpServerComponent,
  IStatusCheckCapableComponent,
} from "@well-known-components/interfaces"
import { _setUnderlyingServer } from "./injectors"
import { getServer, success, getRequestFromNodeMessage } from "./logic"
import type { ServerComponents, IHttpServerOptions } from "./types"
import { createServerHandler } from "./server-handler"
import * as http from "http"
import * as https from "https"
import { createServerTerminator } from "./terminator"
import { Socket } from "net"
import { getWebSocketCallback } from "./ws"
import destroy from "destroy"

/**
 * @public
 */
export type FullHttpServerComponent<Context extends object> = IHttpServerComponent<Context> &
  IBaseComponent &
  IStatusCheckCapableComponent & {
    /**
     * WARNING! this is a very destructive function, it resets all the .use middlewares
     * you must reconfigure your handlers entirely after calling this function
     */
    resetMiddlewares(): void
  }

/**
 * Creates a http-server component
 * @public
 */
export async function createServerComponent<Context extends object>(
  components: ServerComponents,
  options: Partial<IHttpServerOptions>
): Promise<FullHttpServerComponent<Context>> {
  const { config, logs, ws } = components
  const logger = logs.getLogger("http-server")

  // config
  const port = await config.requireNumber("HTTP_SERVER_PORT")
  const host = await config.requireString("HTTP_SERVER_HOST")

  // server
  const app = express()

  // configure cors and compression
  // TODO: set HTTP_SERVER_CORS_[ENABLE,ORIGIN,METHOD,...] to enable and configure
  if (options.cors) {
    app.use(cors(options.cors))
  }

  // TODO: set HTTP_SERVER_COMPRESSION_[ENABLE,...] to enable and configure
  if (options.compression) {
    app.use(compression(options.compression))
  }

  const server = getServer(options, app)
  app.disable("x-powered-by")

  let listen: Promise<typeof server> | undefined

  const terminator = createServerTerminator(server, { logger }, {})

  async function start(): Promise<void> {
    if (listen) {
      logger.error("start() called more than once")
      await listen
      return
    }

    listen = new Promise((resolve, reject) => {
      const errorHandler = (err: Error) => {
        logger.error(err)
        reject(err)
      }

      server.once("error", errorHandler).listen(port, host, () => {
        logger.log(`Listening ${host}:${port}`)
        resolve(server)
        server!.off("error", errorHandler)
      })
    })

    await listen
  }

  async function stop() {
    logger.info(`Closing server`)
    await terminator.terminate()
    logger.info(`Server closed`)
  }

  let configuredContext: Context = Object.create({})

  const serverHandler = createServerHandler<Context>()

  const ret: FullHttpServerComponent<Context> = {
    // IBaseComponent
    start,
    stop,
    // IStatusCheckCapableComponent
    async startupProbe() {
      return true
    },
    async readynessProbe() {
      return server.listening
    },
    // IHttpServerComponent
    use: serverHandler.use,
    setContext(context) {
      configuredContext = Object.create(context)
    },

    // extra
    resetMiddlewares: serverHandler.resetMiddlewares,
  }

  const defaultSchema = server instanceof https.Server ? "https" : "http"

  async function asyncHandle(req: http.IncomingMessage, res: http.ServerResponse) {
    const request = getRequestFromNodeMessage(req, host, defaultSchema)
    const response = await serverHandler.processRequest(configuredContext, request)

    success(response, res)
  }

  async function handleUpgrade(req: http.IncomingMessage, socket: Socket, head: Buffer) {
    if (!ws) {
      throw new Error("No WebSocketServer present")
    }

    const request = getRequestFromNodeMessage(req, host, defaultSchema)
    const response = await serverHandler.processRequest(configuredContext, request)

    const websocketConnect = getWebSocketCallback(response)

    if (websocketConnect) {
      ws.handleUpgrade(req, socket, head, async (wsSocket) => {
        try {
          await websocketConnect(wsSocket)
        } catch (err: any) {
          logger.error(err)
          destroy(socket)
        }
      })
    } else {
      if (response.status) {
        const statusCode = isNaN(response.status) ? 404 : response.status
        const statusText = http.STATUS_CODES[statusCode] || "Not Found"
        socket.end(`HTTP/${req.httpVersion} ${statusCode} ${statusText}\r\n\r\n`)
      } else {
        socket.end()
      }
    }
  }

  if (ws) {
    server.on("upgrade", (req: http.IncomingMessage, socket: Socket, head: Buffer) => {
      return handleUpgrade(req, socket, head).catch((err) => {
        logger.error(err)
        destroy(socket)
      })
    })
  }

  app.use((req, res) => {
    asyncHandle(req, res).catch((error) => {
      logger.error("Unhandled error in http-server middlewares", {
        message: error.message,
        url: req.url,
        ip: req.ip,
        method: req.method,
        stack: error.stack || error.toString(),
      })

      if (error.code == "ERR_INVALID_URL") {
        res.status(404)
        res.end()
      } else {
        res.status(500)
        res.end()
      }
    })
  })

  _setUnderlyingServer(ret, async () => {
    if (!server) throw new Error("The server is stopped")
    return (await listen) || server!
  })

  return ret
}
