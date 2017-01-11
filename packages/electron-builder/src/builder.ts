import { Packager, normalizePlatforms } from "./packager"
import { PublishOptions } from "./publish/publisher"
import { executeFinally } from "electron-builder-util/out/promise"
import BluebirdPromise from "bluebird-lst-c"
import { isEmptyOrSpaces } from "electron-builder-util"
import { log } from "electron-builder-util/out/log"
import { Platform, Arch, archFromString } from "electron-builder-core"
import { DIR_TARGET } from "./targets/targetFactory"
import isCi from "is-ci"
import { PackagerOptions } from "./packagerApi"
import { PublishManager } from "./publish/PublishManager"

export interface BuildOptions extends PackagerOptions, PublishOptions {
}

export interface CliOptions extends PackagerOptions, PublishOptions {
  mac?: Array<string>
  linux?: Array<string>
  win?: Array<string>

  arch?: string

  x64?: boolean
  ia32?: boolean
  armv7l?: boolean

  dir?: boolean

  platform?: string

  project?: string
}

function addValue<K, T>(map: Map<K, Array<T>>, key: K, value: T) {
  const list = map.get(key)
  if (list == null) {
    map.set(key, [value])
  }
  else {
    list.push(value)
  }
}

export function normalizeOptions(args: CliOptions): BuildOptions {
  if (args.targets != null) {
    return args
  }

  let targets = new Map<Platform, Map<Arch, Array<string>>>()

  function processTargets(platform: Platform, types: Array<string>) {
    if (args.platform != null) {
      throw new Error(`--platform cannot be used if --${platform.buildConfigurationKey} is passed`)
    }
    if (args.arch != null) {
      throw new Error(`--arch cannot be used if --${platform.buildConfigurationKey} is passed`)
    }

    function commonArch(): Array<Arch> {
      const result = Array<Arch>()
      if (args.x64) {
        result.push(Arch.x64)
      }
      if (args.armv7l) {
        result.push(Arch.armv7l)
      }
      if (args.ia32) {
        result.push(Arch.ia32)
      }

      return result.length === 0 ? [archFromString(process.arch)] : result
    }

    let archToType = targets.get(platform)
    if (archToType == null) {
      archToType = new Map<Arch, Array<string>>()
      targets.set(platform, archToType)
    }

    if (types.length === 0) {
      const defaultTargetValue = args.dir ? [DIR_TARGET] : []
      if (platform === Platform.MAC) {
        archToType.set(Arch.x64, defaultTargetValue)
      }
      else {
        for (const arch of commonArch()) {
          archToType.set(arch, defaultTargetValue)
        }
      }
      return
    }

    for (const type of types) {
      let arch: string
      if (platform === Platform.MAC) {
        arch = "x64"
        addValue(archToType, Arch.x64, type)
      }
      else {
        const suffixPos = type.lastIndexOf(":")
        if (suffixPos > 0) {
          addValue(archToType, archFromString(type.substring(suffixPos + 1)), type.substring(0, suffixPos))
        }
        else {
          for (const arch of commonArch()) {
            addValue(archToType, arch, type)
          }
        }
      }
    }
  }

  if (args.mac != null) {
    processTargets(Platform.MAC, args.mac)
  }

  if (args.linux != null) {
    processTargets(Platform.LINUX, args.linux)
  }

  if (args.win != null) {
    processTargets(Platform.WINDOWS, args.win)
  }

  if (targets.size === 0) {
    if (args.platform == null && args.arch == null) {
      processTargets(Platform.current(), [])
    }
    else {
      targets = createTargets(normalizePlatforms(args.platform), args.dir ? DIR_TARGET : null, args.arch)
    }
  }

  const result = Object.assign({}, args)
  result.targets = targets

  delete result.dir
  delete result.mac
  delete result.linux
  delete result.win
  delete result.platform
  delete result.arch

  const r = <any>result
  delete r.em

  delete r.m
  delete r.o
  delete r.l
  delete r.w
  delete r.windows
  delete r.macos
  delete r.$0
  delete r._
  delete r.version
  delete r.help

  delete result.ia32
  delete result.x64
  delete result.armv7l

  if (result.project != null) {
    result.projectDir = result.project
  }
  delete result.project
  return result
}

export function createTargets(platforms: Array<Platform>, type?: string | null, arch?: string | null): Map<Platform, Map<Arch, Array<string>>> {
  const targets = new Map<Platform, Map<Arch, Array<string>>>()
  for (const platform of platforms) {
    const archs = platform === Platform.MAC ? [Arch.x64] : (arch === "all" ? [Arch.x64, Arch.ia32] : [archFromString(arch == null ? process.arch : arch)])
    const archToType = new Map<Arch, Array<string>>()
    targets.set(platform, archToType)

    for (const arch of archs) {
      archToType.set(arch, type == null ? [] : [type])
    }
  }
  return targets
}

export async function build(rawOptions?: CliOptions): Promise<Array<string>> {
  const options = normalizeOptions(rawOptions || {})

  if (options.cscLink === undefined && !isEmptyOrSpaces(process.env.CSC_LINK)) {
    options.cscLink = process.env.CSC_LINK
  }
  if (options.cscInstallerLink === undefined && !isEmptyOrSpaces(process.env.CSC_INSTALLER_LINK)) {
    options.cscInstallerLink = process.env.CSC_INSTALLER_LINK
  }
  if (options.cscKeyPassword === undefined && !isEmptyOrSpaces(process.env.CSC_KEY_PASSWORD)) {
    options.cscKeyPassword = process.env.CSC_KEY_PASSWORD
  }
  if (options.cscInstallerKeyPassword === undefined && !isEmptyOrSpaces(process.env.CSC_INSTALLER_KEY_PASSWORD)) {
    options.cscInstallerKeyPassword = process.env.CSC_INSTALLER_KEY_PASSWORD
  }

  if (options.draft === undefined && !isEmptyOrSpaces(process.env.EP_DRAFT)) {
    options.draft = process.env.EP_DRAFT.toLowerCase() === "true"
  }
  if (options.prerelease === undefined && !isEmptyOrSpaces(process.env.EP_PRELEASE)) {
    options.prerelease = process.env.EP_PRELEASE.toLowerCase() === "true"
  }

  let isPublishOptionGuessed = false
  if (options.publish === undefined) {
    if (process.env.npm_lifecycle_event === "release") {
      options.publish = "always"
    }
    else if (isAuthTokenSet() ) {
      const tag = process.env.TRAVIS_TAG || process.env.APPVEYOR_REPO_TAG_NAME || process.env.CIRCLE_TAG
      if (!isEmptyOrSpaces(tag)) {
        log(`Tag ${tag} is defined, so artifacts will be published`)
        options.publish = "onTag"
        isPublishOptionGuessed = true
      }
      else if (isCi) {
        log("CI detected, so artifacts will be published if draft release exists")
        options.publish = "onTagOrDraft"
        isPublishOptionGuessed = true
      }
    }
  }

  const packager = new Packager(options)
  let publishManager: PublishManager | null = null
  if (options.publish != null && options.publish !== "never") {
    // todo if token set as option
    if (isAuthTokenSet()) {
      publishManager = new PublishManager(packager, options, isPublishOptionGuessed)
    }
    else if (isCi) {
      log(`CI detected, publish is set to ${options.publish}, but neither GH_TOKEN nor BT_TOKEN is not set, so artifacts will be not published`)
    }
  }

  //noinspection JSMismatchedCollectionQueryUpdate
  const artifactPaths: Array<string> = []
  packager.artifactCreated(event => {
    if (event.file != null) {
      artifactPaths.push(event.file)
    }
  })

  return await executeFinally(packager.build().then(() => artifactPaths), errorOccurred => {
    if (publishManager == null) {
      return BluebirdPromise.resolve(null)
    }

    if (errorOccurred) {
      publishManager.cancelTasks()
      return BluebirdPromise.resolve(null)
    }
    else {
      return publishManager.awaitTasks()
    }
  })
}

function isAuthTokenSet() {
  return !isEmptyOrSpaces(process.env.GH_TOKEN) || !isEmptyOrSpaces(process.env.BT_TOKEN)
}