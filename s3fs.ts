import { patchFs } from '@aleung/fs-monkey'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import deasync from 'deasync'
import fs, { PathLike, Stats } from 'fs'
import _path from 'path'
import { Readable } from 'stream'

const bucket = process.env.CACHE_BUCKET_NAME

if (!bucket) {
  throw new Error('CACHE_BUCKET_NAME not set')
}

const s3 = new S3Client()

const normalize_path = (path: string) => {
  path = _path.normalize(path)
  path = _path.resolve(process.cwd(), path)
  // p = path.relative(require.main.path, p)
  path = path.replace(new RegExp(`^${_path.sep}+`, 'g'), '')
  // p = `${p}`
  // p = `s3fs:${p}`
  return path
}

const normalize_dir = (path: string) => `${normalize_path(path)}${_path.sep}`

const streamToBuffer = async (rawStream: any) => {
  const stream: Readable = rawStream
  return new Promise((resolve, reject) => {
    const chunks: any[] = []
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks))) // can call .toString("utf8") on the buffer
  })
}

const DEFAULT_TIMEOUTS = 10 * 1000

const STATE = {
  INITIAL: 'INITIAL',
  RESOLVED: 'RESOLVED',
  REJECTED: 'REJECTED',
}

const DEFAULT_TICK = 100

function sp(func: Function) {
  return (...args: any[]) => {
    let promiseError, promiseValue
    let promiseStatus = STATE.INITIAL
    const timeouts = DEFAULT_TIMEOUTS
    const tick = DEFAULT_TICK

    func
      .apply(this, args)
      .then((value) => {
        promiseValue = value
        promiseStatus = STATE.RESOLVED
      })
      .catch((e) => {
        promiseError = e
        promiseStatus = STATE.REJECTED
      })

    const waitUntil = new Date(new Date().getTime() + timeouts)
    while (waitUntil > new Date() && promiseStatus === STATE.INITIAL) {
      deasync.sleep(tick)
    }

    if (promiseStatus === STATE.RESOLVED) {
      return promiseValue
    } else if (promiseStatus === STATE.REJECTED) {
      throw promiseError
    } else {
      throw new Error(`${func.name} called timeout`)
    }
  }
}

const readFile = async (fileName: string, _options?: unknown) => {
  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: normalize_path(fileName),
  })

  const obj = await s3.send(cmd)
  if (!obj.Body) throw new Error('No body')
  return streamToBuffer(obj.Body)
}

const writeFile = async (fileName: string, data: any, _options: unknown) => {
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: normalize_path(fileName),
    Body: data,
  })

  await s3.send(cmd)
}

const exists = async (fileName: string, _data?: any, _options?: unknown) => {
  const cmd = new HeadObjectCommand({
    Bucket: bucket,
    Key: normalize_path(fileName),
  })

  try {
    const res = await s3.send(cmd)
    return !!res.LastModified
  } catch (e) {
    if (e.name === 'NotFound') {
      return false
    } else {
      throw e
    }
  }
}

const stat = async (fileName: string, _data?: any, _options?: unknown) => {
  fileName = normalize_path(fileName)
  const cmd = new HeadObjectCommand({ Bucket: bucket, Key: fileName })

  try {
    const data = await s3.send(cmd)
    const modified_ms = new Date(data.LastModified!).getTime()

    const values = Object.values({
      dev: 0,
      mode: 0,
      nlink: 0,
      uid: 0,
      gid: 0,
      rdev: 0,
      blksize: 0,
      ino: 0,
      size: Number(data.ContentLength),
      blocks: 0,
      atimeMs: modified_ms,
      mtimeMs: modified_ms,
      ctimeMs: modified_ms,
      birthtimeMs: modified_ms,
      atime: data.LastModified,
      mtime: data.LastModified,
      ctime: data.LastModified,
      birthtime: data.LastModified,
    })

    // @ts-ignore
    return new Stats(...values)
  } catch (e) {
    if (e.name === 'NotFound') {
      throw new Error(`ENOENT: no such file or directory, stat '${fileName}'`)
    }

    throw e
  }
}

const mkdir = async (path: string) => {
  path = normalize_dir(path)
  const cmd = new PutObjectCommand({ Bucket: bucket, Key: path })
  await s3.send(cmd)
}

const readdir = async (path: string) => {
  path = normalize_dir(path)
  const cmd = new ListObjectsV2Command({
    Bucket: bucket,
    // StartAfter: path,
    Prefix: path,
    // Delimiter: '/'
    Delimiter: _path.sep,
  })
  try {
    const result = await s3.send(cmd)
    if (!result.Contents && !result.CommonPrefixes) {
      throw new Error('NotFound')
    }

    const trailing_sep = new RegExp(`${_path.sep}$`)

    const folders = (result.CommonPrefixes || []).map((r) => {
      return r.Prefix!.replace(path, '').replace(trailing_sep, '')
    })

    const files = (result.Contents || []).map((r) => {
      return r.Key!.replace(path, '')
    })

    return [...folders, ...files].filter((r) => r.length)
  } catch (e) {
    if (e.name === 'NotFound' || e.message === 'NotFound') {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`)
    } else {
      throw e
    }
  }
}

const rm = async (path: string) => {
  let f = await Promise.allSettled([stat(path), readdir(path)])

  if (f[0].status == 'rejected' && f[1].status == 'fulfilled') {
    throw new Error(
      `SystemError [ERR_FS_EISDIR]: Path is a directory: rm returned EISDIR (is a directory) ${path}`
    )
  }

  if (f[0].status == 'rejected' && f[1].status == 'rejected') {
    throw f[0].reason
  }

  path = normalize_path(path)
  const cmd = new DeleteObjectCommand({ Bucket: bucket, Key: path })
  await s3.send(cmd)
}

const rmdir = async (path: string) => {
  let contents = await readdir(path)
  if (contents.length) {
    throw new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`)
  }

  path = normalize_dir(path)
  const cmd = new DeleteObjectCommand({ Bucket: bucket, Key: path })
  await s3.send(cmd)
}

const unlink = async (path: string) => {
  let f = await Promise.allSettled([stat(path), readdir(path)])

  if (f[0].status == 'rejected' && f[1].status == 'fulfilled') {
    throw new Error(`EPERM: operation not permitted, unlink '${path}'`)
  }
  if (f[0].status == 'rejected' && f[1].status == 'rejected') {
    throw f[0].reason
  }
  path = normalize_path(path)
  const cmd = new DeleteObjectCommand({ Bucket: bucket, Key: path })
  await s3.send(cmd)
}

const promises = {
  readFile,
  writeFile,
  exists,
  stat,
  mkdir,
  readdir,
  rm,
  rmdir,
  unlink,
}

const s3fs = {
  ...promises,
  promises,
  readFileSync: sp(readFile),
  writeFileSync: sp(writeFile),
  existsSync: sp(exists),
  statSync: sp(stat),
  mkdirSync: sp(mkdir),
  readdirSync: sp(readdir),
  rmSync: sp(rm),
  rmdirSync: sp(rmdir),
  unlinkSync: sp(unlink),
}

/*
  https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/incremental-cache/file-system-cache.ts

  // persisted across deployments
  this.tagsManifestPath = path.join(
        this.serverDistDir,
        '..',
        'cache',
        'fetch-cache',
        'tags-manifest.json'
      )

    const NEXT_META_SUFFIX = '.meta'

    .next/pages/
    .next/app/
*/

// See: https://github.com/vercel/next.js/blob/31809e42f512a6e1482b709ef94fd5191ca5c240/packages/next/src/server/image-optimizer.ts#L105
const isImageCache = (path: string) =>
  path.includes('cache/images')
    ? //
      path.split('.next/cache')[1]
    : false

// See: https://github.com/vercel/next.js/blob/31809e42f512a6e1482b709ef94fd5191ca5c240/packages/next/src/server/lib/incremental-cache/file-system-cache.ts#L435C12-L435C12
const isIsrFetchCache = (path: string) =>
  path.includes('cache/fetch-cache')
    ? path.split('cache/fetch-cache')[1]
    : false

// @TODO: static files should be deployed to S3? Currently not a problem.

const defaultRewrite =
  (fn: Function, original: Function) =>
  (pathLike: PathLike, ...rest: any[]) => {
    const reqPath = pathLike.toString()
    const isr = isIsrFetchCache(reqPath)
    const img = isImageCache(reqPath)
    if (isr || img) {
      console.log(`[s3fs] ${isr || img}`)
      return fn(isr, ...rest)
    } else {
      return original(pathLike, ...rest)
    }
  }

const nextFs = {
  existsSync: defaultRewrite(s3fs.existsSync, fs.existsSync),
  mkdir: defaultRewrite(s3fs.mkdir, fs.mkdir),
  mkdirSync: defaultRewrite(s3fs.mkdirSync, fs.mkdirSync),
  readFile: defaultRewrite(s3fs.readFile, fs.readFile),
  readFileSync: defaultRewrite(s3fs.readFileSync, fs.readFileSync),
  stat: defaultRewrite(s3fs.stat, fs.stat),
  statSync: defaultRewrite(s3fs.statSync, fs.statSync),
  writeFile: defaultRewrite(s3fs.writeFile, fs.writeFile),
  writeFileSync: defaultRewrite(s3fs.writeFileSync, fs.writeFileSync),
  rm: defaultRewrite(s3fs.rm, fs.rm),
  rmSync: defaultRewrite(s3fs.rmSync, fs.rmSync),

  promises: {
    mkdir: defaultRewrite(s3fs.mkdir, fs.mkdir),
    readFile: defaultRewrite(s3fs.readFile, fs.readFile),
    stat: defaultRewrite(s3fs.stat, fs.stat),
    writeFile: defaultRewrite(s3fs.writeFile, fs.writeFile),
    rm: defaultRewrite(s3fs.rm, fs.rm),
    readdir: defaultRewrite(s3fs.readdir, fs.readdir),
  },
}

patchFs(nextFs)
