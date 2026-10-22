import { describe, expect, test } from "bun:test"
import { OpenApi } from "effect/http-api"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"

type Method = "get" | "post" | "put" | "delete" | "patch"
type OpenApiSchema = {
  readonly $ref?: string
  readonly type?: string
  readonly anyOf?: OpenApiSchema[]
  readonly properties?: Record<string, OpenApiSchema>
}
type OpenApiResponse = {
  readonly description?: string
  readonly content?: Record<string, { readonly schema?: OpenApiSchema }>
}
type OpenApiOperation = {
  readonly responses?: Record<string, OpenApiResponse>
  readonly security?: unknown
  readonly requestBody?: { readonly content?: Record<string, { readonly schema?: OpenApiSchema }> }
}
type OpenApiPathItem = Partial<Record<Method, OpenApiOperation>>
type OpenApiSpec = {
  readonly paths: Record<string, OpenApiPathItem>
  readonly components?: { readonly schemas?: Record<string, OpenApiSchema> }
}

const methods = ["get", "post", "put", "delete", "patch"] as const

const allowedV2BuiltInEndpointErrors: string[] = []

function v2Operations(spec: OpenApiSpec) {
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    path.startsWith("/api/")
      ? methods.flatMap((method) => {
          const operation = item[method]
          return operation ? [{ method, path, operation }] : []
        })
      : [],
  )
}

function responseRef(response: OpenApiResponse | undefined) {
  return response?.content?.["application/json"]?.schema?.$ref
}

function componentName(ref: string) {
  return ref.replace("#/components/schemas/", "")
}

function isBuiltInEndpointError(name: string) {
  return name.startsWith("EffectHttpApiError") || name.startsWith("effect_HttpApiError_")
}

describe("PublicApi OpenAPI v2 errors", () => {
  test("keeps provider authorization component names stable for SDK consumers", () => {
    const schemas = (OpenApi.fromApi(PublicApi) as OpenApiSpec).components?.schemas
    expect(schemas?.ProviderAuthMethod).toBeDefined()
    expect(schemas?.ProviderAuthAuthorization).toBeDefined()
    expect(schemas?.ProviderAuthMethodEncoded).toBeUndefined()
    expect(schemas?.ProviderAuthAuthorizationEncoded).toBeUndefined()
  })

  test("uses the canonical config component for both update request bodies", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec
    for (const route of ["/config", "/global/config"]) {
      expect(spec.paths[route]?.patch?.requestBody?.content?.["application/json"]?.schema?.$ref).toBe(
        "#/components/schemas/Config",
      )
    }
    expect(Object.keys(spec.components?.schemas ?? {}).filter((name) => /^Config_?\d+$/.test(name))).toEqual([])
  })

  test("preserves the object payload of output-length errors", () => {
    const schemas = (OpenApi.fromApi(PublicApi) as OpenApiSpec).components?.schemas
    expect(schemas?.MessageOutputLengthError?.properties?.data?.type).toBe("object")
  })

  test("keeps distinct legacy and v2 unknown-error payloads separate", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec
    const name = componentName(
      responseRef(spec.paths["/api/session/{sessionID}/context"]?.get?.responses?.["500"]) ?? "",
    )
    expect(name).toMatch(/^UnknownError\d+$/)
    expect(spec.components?.schemas?.UnknownError?.properties?.data).toBeDefined()
    expect(spec.components?.schemas?.[name]?.properties?._tag).toBeDefined()
    expect(spec.components?.schemas?.[name]?.properties?.data).toBeUndefined()
  })

  test("preserves the genuinely nullable oldest session-change cursor", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec
    const schema =
      spec.paths["/session/{sessionID}/changes"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema
    const properties = schema?.$ref
      ? spec.components?.schemas?.[componentName(schema.$ref)]?.properties
      : schema?.properties
    expect(properties?.oldest?.anyOf?.some((item) => item.type === "null")).toBe(true)
  })

  test("preserves /api auth responses", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    for (const route of v2Operations(spec)) {
      expect(route.operation.responses?.["401"], `${route.method.toUpperCase()} ${route.path}`).toBeDefined()
      expect(route.operation.security, `${route.method.toUpperCase()} ${route.path}`).toEqual([])
    }
  })

  test("does not rewrite /api endpoint errors to legacy error components", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec
    const refs = v2Operations(spec)
      .flatMap((route) =>
        Object.entries(route.operation.responses ?? {}).flatMap(([status, response]) => {
          const ref = responseRef(response)
          return ref ? [`${route.method.toUpperCase()} ${route.path} ${status} ${componentName(ref)}`] : []
        }),
      )
      .filter((entry) => entry.endsWith(" BadRequestError") || entry.endsWith(" NotFoundError"))

    expect(refs).toEqual([])
  })

  test("new /api endpoint errors cannot use built-in components without an explicit allowlist", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec
    const builtInEndpointErrors = v2Operations(spec)
      .flatMap((route) =>
        Object.entries(route.operation.responses ?? {}).flatMap(([status, response]) => {
          if (status === "401") return []
          const ref = responseRef(response)
          if (!ref) return []
          const name = componentName(ref)
          return isBuiltInEndpointError(name) ? [`${route.method.toUpperCase()} ${route.path} ${status} ${name}`] : []
        }),
      )
      .sort()

    expect(builtInEndpointErrors).toEqual(allowedV2BuiltInEndpointErrors)
  })

  test("documents v2 provider and model catalog errors", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    expect(componentName(responseRef(spec.paths["/api/provider"]?.get?.responses?.["503"]) ?? "")).toBe(
      "ServiceUnavailableError",
    )
    expect(componentName(responseRef(spec.paths["/api/model"]?.get?.responses?.["503"]) ?? "")).toBe(
      "ServiceUnavailableError",
    )
    expect(componentName(responseRef(spec.paths["/api/provider/{providerID}"]?.get?.responses?.["404"]) ?? "")).toBe(
      "ProviderNotFoundError",
    )
    expect(componentName(responseRef(spec.paths["/api/provider/{providerID}"]?.get?.responses?.["503"]) ?? "")).toBe(
      "ServiceUnavailableError",
    )
  })

  test("documents v2 session not-found errors", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    for (const route of [
      ["post", "/api/session/{sessionID}/prompt"],
      ["post", "/api/session/{sessionID}/compact"],
      ["post", "/api/session/{sessionID}/wait"],
      ["get", "/api/session/{sessionID}/context"],
      ["get", "/api/session/{sessionID}/message"],
    ] as const) {
      expect(componentName(responseRef(spec.paths[route[1]]?.[route[0]]?.responses?.["404"]) ?? "")).toBe(
        "SessionNotFoundError",
      )
    }
  })

  test("documents v2 unfinished session mutation errors", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    for (const route of [
      ["post", "/api/session/{sessionID}/prompt"],
      ["post", "/api/session/{sessionID}/compact"],
      ["post", "/api/session/{sessionID}/wait"],
    ] as const) {
      expect(componentName(responseRef(spec.paths[route[1]]?.[route[0]]?.responses?.["503"]) ?? "")).toBe(
        "ServiceUnavailableError",
      )
    }
  })

  test("documents v2 session read data errors", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    for (const route of [
      ["get", "/api/session/{sessionID}/context"],
      ["get", "/api/session/{sessionID}/message"],
    ] as const) {
      expect(componentName(responseRef(spec.paths[route[1]]?.[route[0]]?.responses?.["500"]) ?? "")).toMatch(
        /^UnknownError\d*$/,
      )
    }
  })

  test("documents session busy errors", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    for (const route of [
      ["post", "/session/{sessionID}/shell"],
      ["post", "/session/{sessionID}/revert"],
      ["post", "/session/{sessionID}/unrevert"],
      ["delete", "/session/{sessionID}/message/{messageID}"],
    ] as const) {
      expect(componentName(responseRef(spec.paths[route[1]]?.[route[0]]?.responses?.["409"]) ?? "")).toBe(
        "SessionBusyError",
      )
    }
  })

  test("documents permission and question not-found errors", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    expect(
      componentName(responseRef(spec.paths["/permission/{requestID}/reply"]?.post?.responses?.["404"]) ?? ""),
    ).toBe("PermissionNotFoundError")
    for (const route of [
      ["post", "/question/{requestID}/reply"],
      ["post", "/question/{requestID}/reject"],
    ] as const) {
      expect(componentName(responseRef(spec.paths[route[1]]?.[route[0]]?.responses?.["404"]) ?? "")).toBe(
        "QuestionNotFoundError",
      )
    }
  })
})
