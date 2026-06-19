declare global {
  namespace NodeJS {
    interface ProcessEnv {
      [key: string]: string | undefined
    }
  }
}

declare module "http" {
  interface IncomingHttpHeaders {
    [header: string]: string | string[] | undefined
  }
}

export {}
