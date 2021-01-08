import { IBaseComponent, IHttpServerComponent, IStatusCheckCapableComponent } from "@well-known-components/interfaces"
import { Router } from "./router"

/**
 * Binds status checks to the server
 *  - GET /health/ready - readyness probe
 *  - GET /health/startup - startup probe
 *  - GET /health/live - liveness probe
 * @public
 */
export async function createStatusCheckComponent<Context extends object = {}>(components: {
  server: IHttpServerComponent<Context>
}): Promise<IBaseComponent> {
  const { server } = components

  let mutStartOptions: IBaseComponent.ComponentStartOptions | undefined

  const routes = new Router()

  /**
   * Readiness probes indicate whether your application is ready to
   * handle requests. It could be that your application is alive, but
   * that it just can't handle HTTP traffic. In that case, Kubernetes
   * won't kill the container, but it will stop sending it requests.
   * In practical terms, that means the pod is removed from an
   * associated service's "pool" of pods that are handling requests,
   * by marking the pod as "Unready".
   */
  routes.get("/health/ready", async (ctx) => {
    if (!mutStartOptions) {
      return { body: "initializing", status: 400 }
    }
    if (mutStartOptions.started()) {
      return { body: "ready", status: 200 }
    } else if (mutStartOptions.live()) {
      return { body: "unready", status: 400 }
    }
    return { body: "waiting", status: 400 }
  })

  /**
   * The first probe to run is the Startup probe.
   * When your app starts up, it might need to do a lot of work.
   * It might need to fetch data from remote services, load dlls
   * from plugins, who knows what else. During that process, your
   * app should either not respond to requests, or if it does, it
   * should return a status code of 400 or higher. Once the startup
   * process has finished, you can switch to returning a success
   * res (200) for the startup probe.
   */
  routes.get("/health/startup", async () => {
    if (!mutStartOptions) {
      return { body: "bootstrapping", status: 400 }
    } else if (!mutStartOptions.started()) {
      return { body: "starting", status: 400 }
    }

    const components: Record<string, IStatusCheckCapableComponent> = mutStartOptions.getComponents()

    const probes: { name: string; promise: Promise<boolean> }[] = []

    for (let c in components) {
      if (typeof components[c].startupProbe == "function") {
        probes.push({
          name: c,
          promise: new Promise((ok) => {
            components[c].startupProbe!()
              .then(ok)
              .catch(() => ok(false))
          }),
        })
      }
    }

    const results = await Promise.all(probes.map(($) => $.promise))

    const content = probes
      .map((content, index) => ("[" + content.name + "] " + results[index] ? "ok" : "not-ok"))
      .join("\n")

    return {
      status: results.some(($) => $ == false) ? 400 : 200,
      body: content,
    }
  })

  /**
   * The liveness probe is what you might expect-it indicates whether
   * the container is alive or not. If a container fails its liveness
   * probe, Kubernetes will kill the pod and restart another.
   */
  routes.get("/health/live", async () => {
    return { status: 200, body: "alive" }
  })

  const middleware = routes.routes()
  server.use(middleware)

  return {
    async start(opt) {
      mutStartOptions = opt
    },
  }
}
