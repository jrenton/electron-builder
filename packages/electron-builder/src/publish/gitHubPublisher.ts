import { isEmptyOrSpaces } from "electron-builder-util"
import { log, warn } from "electron-builder-util/out/log"
import { debug } from "electron-builder-util"
import { parse as parseUrl } from "url"
import mime from "mime"
import BluebirdPromise from "bluebird-lst-c"
import { PublishOptions, Publisher } from "./publisher"
import { GithubOptions } from "electron-builder-http/out/publishOptions"
import { ClientRequest } from "http"
import { HttpError, configureRequestOptions } from "electron-builder-http"
import { NodeHttpExecutor } from "../util/nodeHttpExecutor"

export interface Release {
  id: number
  tag_name: string

  draft: boolean
  prerelease: boolean

  published_at: string

  upload_url: string
}

interface Asset {
  id: number
  name: string
}

export class GitHubPublisher extends Publisher {
  private tag: string
  private _releasePromise: Promise<Release>
  private readonly httpExecutor = new NodeHttpExecutor()

  private readonly token: string

  get releasePromise(): Promise<Release | null> {
    if (this._releasePromise == null) {
      this._releasePromise = this.token === "__test__" ? BluebirdPromise.resolve(<any>null) : this.getOrCreateRelease()
    }
    return this._releasePromise
  }

  constructor(private readonly info: GithubOptions, private readonly version: string, private readonly options: PublishOptions = {}) {
    super()

    let token = info.token
    if (isEmptyOrSpaces(token)) {
      token = process.env.GH_TOKEN
      if (isEmptyOrSpaces(token)) {
        throw new Error(`GitHub Personal Access Token is not set, neither programmatically, nor using env "GH_TOKEN"`)
      }
    }

    this.token = token!

    if (version.startsWith("v")) {
      throw new Error(`Version must not starts with "v": ${version}`)
    }

    this.tag = info.vPrefixedTagName === false ? version : `v${version}`
  }

  private async getOrCreateRelease(): Promise<Release | null> {
    // we don't use "Get a release by tag name" because "tag name" means existing git tag, but we draft release and don't create git tag
    const releases = await this.githubRequest<Array<Release>>(`/repos/${this.info.owner}/${this.info.repo}/releases`, this.token)
    for (const release of releases) {
      if (release.tag_name === this.tag || release.tag_name === this.version) {
        if (release.draft || release.prerelease) {
          return release
        }

        // https://github.com/electron-userland/electron-builder/issues/1133
        // if release created < 2 hours — allow to upload
        const publishedAt = release.published_at == null ? null : new Date(release.published_at)
        if (publishedAt != null && (Date.now() - publishedAt.getMilliseconds()) > (2 * 3600 * 1000)) {
          // https://github.com/electron-userland/electron-builder/issues/1183#issuecomment-275867187
          warn(`Release with tag ${this.tag} published at ${publishedAt.toString()}, more than 2 hours ago`)
          return null
        }
        return release
      }
    }

    log(`Release with tag ${this.tag} doesn't exist, creating one`)
    return this.createRelease()
  }

  protected async doUpload(fileName: string, dataLength: number, requestProcessor: (request: ClientRequest, reject: (error: Error) => void) => void): Promise<void> {
    const release = await this.releasePromise
    if (release == null) {
      debug(`Release with tag ${this.tag} doesn't exist and is not created, artifact ${fileName} is not published`)
      return
    }

    const parsedUrl = parseUrl(release.upload_url.substring(0, release.upload_url.indexOf("{")) + "?name=" + fileName)
    let badGatewayCount = 0
    uploadAttempt: for (let i = 0; i < 3; i++) {
      try {
        return await this.httpExecutor.doApiRequest<any>(configureRequestOptions({
          hostname: parsedUrl.hostname,
          path: parsedUrl.path,
          method: "POST",
          headers: {
            Accept: "application/vnd.github.v3+json",
            "Content-Type": mime.lookup(fileName),
            "Content-Length": dataLength
          }
        }, this.token), requestProcessor)
      }
      catch (e) {
        if (e instanceof HttpError) {
          if (e.response.statusCode === 422 && e.description != null && e.description.errors != null && e.description.errors[0].code === "already_exists") {
            // delete old artifact and re-upload
            log(`Artifact ${fileName} already exists, overwrite one`)

            const assets = await this.githubRequest<Array<Asset>>(`/repos/${this.info.owner}/${this.info.repo}/releases/${release.id}/assets`, this.token, null)
            for (const asset of assets) {
              if (asset!.name === fileName) {
                await this.githubRequest<void>(`/repos/${this.info.owner}/${this.info.repo}/releases/assets/${asset!.id}`, this.token, null, "DELETE")
                continue uploadAttempt
              }
            }

            log(`Artifact ${fileName} not found, trying to upload again`)
            continue
          }
          else if (e.response.statusCode === 502 && badGatewayCount++ < 3) {
            continue
          }
        }

        throw e
      }
    }
  }

  private createRelease() {
    return this.githubRequest<Release>(`/repos/${this.info.owner}/${this.info.repo}/releases`, this.token, {
      tag_name: this.tag,
      name: this.version,
      draft: this.options.draft == null || this.options.draft,
      prerelease: this.options.prerelease != null && this.options.prerelease,
    })
  }

  // test only
  //noinspection JSUnusedGlobalSymbols
  async getRelease(): Promise<any> {
    return this.githubRequest<Release>(`/repos/${this.info.owner}/${this.info.repo}/releases/${(await this._releasePromise).id}`, this.token)
  }

  //noinspection JSUnusedGlobalSymbols
  async deleteRelease(): Promise<any> {
    const release = await this._releasePromise
    if (release == null) {
      return
    }

    for (let i = 0; i < 3; i++) {
      try {
        return await this.githubRequest(`/repos/${this.info.owner}/${this.info.repo}/releases/${release.id}`, this.token, null, "DELETE")
      }
      catch (e) {
        if (e instanceof HttpError) {
          if (e.response.statusCode === 404) {
            warn(`Cannot delete release ${release.id} — doesn't exist`)
            return
          }
          else if (e.response.statusCode === 405 || e.response.statusCode === 502) {
            continue
          }
        }

        throw e
      }
    }

    warn(`Cannot delete release ${release.id}`)
  }

  private githubRequest<T>(path: string, token: string | null, data: {[name: string]: any; } | null = null, method?: "GET" | "DELETE" | "PUT"): Promise<T> {
    return this.httpExecutor.request<T>(configureRequestOptions({
      hostname: "api.github.com",
      path: path,
      headers: {Accept: "application/vnd.github.v3+json"}
    }, token, method), data)
  }
}