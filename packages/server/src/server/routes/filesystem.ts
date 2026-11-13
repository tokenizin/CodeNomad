import { FastifyInstance } from "fastify"
import { z } from "zod"
import { FileSystemBrowser } from "../../filesystem/browser"
import { searchFileContents, searchFileNames } from "../../filesystem/discovery"

interface RouteDeps {
  fileSystemBrowser: FileSystemBrowser
}

const FilesystemQuerySchema = z.object({
  path: z.string().optional(),
  includeFiles: z.coerce.boolean().optional(),
})

const FilesystemCreateFolderSchema = z.object({
  parentPath: z.string().optional(),
  name: z.string(),
})

const FilesystemFileContentQuerySchema = z.object({
  path: z.string(),
  encoding: z.enum(["utf-8", "base64"]).optional(),
})

const FilesystemSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  /** Directory to search, in the form `/api/filesystem` returns it. Defaults to the root. */
  path: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
  depth: z.coerce.number().int().min(0).optional(),
})

/** Aborts when the client goes away before the answer is sent (the person typed something else, or closed the dialog). */
function abortOnDisconnect(raw: { on(event: "close", listener: () => void): unknown; writableEnded: boolean }): AbortSignal {
  const controller = new AbortController()
  raw.on("close", () => {
    if (!raw.writableEnded) controller.abort()
  })
  return controller.signal
}

export function registerFilesystemRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/filesystem", async (request, reply) => {
    const query = FilesystemQuerySchema.parse(request.query ?? {})

    try {
      return deps.fileSystemBrowser.browse(query.path, {
        includeFiles: query.includeFiles,
      })
    } catch (error) {
      reply.code(400)
      return { error: (error as Error).message }
    }
  })

  app.post("/api/filesystem/folders", async (request, reply) => {
    const body = FilesystemCreateFolderSchema.parse(request.body ?? {})

    try {
      const created = deps.fileSystemBrowser.createFolder(body.parentPath, body.name)
      reply.code(201)
      return created
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err?.code === "EEXIST") {
        reply.code(409).type("text/plain").send("Folder already exists")
        return
      }
      if (err?.code === "EACCES" || err?.code === "EPERM") {
        reply.code(403).type("text/plain").send("Permission denied")
        return
      }

      reply.code(400).type("text/plain").send((error as Error).message)
    }
  })

  // File-name search through nested folders, for the "Attach files" dialog. Confined to the configured root.
  app.get("/api/filesystem/search", async (request, reply) => {
    const query = FilesystemSearchQuerySchema.safeParse(request.query ?? {})
    if (!query.success) {
      reply.code(400)
      return { error: "q is required (1 to 200 characters)" }
    }
    try {
      return await searchFileNames(deps.fileSystemBrowser, query.data.q, {
        path: query.data.path,
        limit: query.data.limit,
        depth: query.data.depth,
        signal: abortOnDisconnect(reply.raw),
      })
    } catch (error) {
      reply.code(400)
      return { error: (error as Error).message }
    }
  })

  // Full-text search (ranked, with matching lines). Confined to the configured root; files over the attach limit are left out.
  app.get("/api/filesystem/content-search", async (request, reply) => {
    const query = FilesystemSearchQuerySchema.safeParse(request.query ?? {})
    if (!query.success) {
      reply.code(400)
      return { error: "q is required (1 to 200 characters)" }
    }
    try {
      return await searchFileContents(deps.fileSystemBrowser, query.data.q, {
        path: query.data.path,
        limit: query.data.limit,
        signal: abortOnDisconnect(reply.raw),
      })
    } catch (error) {
      reply.code(400)
      return { error: (error as Error).message }
    }
  })

  app.get("/api/filesystem/files/content", async (request, reply) => {
    const query = FilesystemFileContentQuerySchema.parse(request.query ?? {})

    try {
      return deps.fileSystemBrowser.readFileContent(query.path, { encoding: query.encoding })
    } catch (error) {
      reply.code(400).type("text/plain").send((error as Error).message)
    }
  })
}
