import { asyncBufferFromUrl, cachedAsyncBuffer, parquetReadObjects } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { avroData } from './avro.data.js'
import { avroMetadata } from './avro.metadata.js'

/**
 * Translates an S3A URL to an HTTPS URL for direct access to the object.
 *
 * @param {string} url
 * @returns {string}
 */
export function translateS3Url(url) {
  if (url.startsWith('s3a://')) {
    const rest = url.slice('s3a://'.length)
    const slashIndex = rest.indexOf('/')
    if (slashIndex === -1) {
      throw new Error('Invalid S3 URL, missing "/" after bucket')
    }
    const bucket = rest.slice(0, slashIndex)
    const key = rest.slice(slashIndex)
    return `https://${bucket}.s3.amazonaws.com${key}`
  }
  return url
}

/**
 * Returns manifest URLs for the current snapshot separated into data and delete manifests.
 *
 * @import {IcebergMetadata, Manifest, ManifestEntry} from './types.js'
 * @param {IcebergMetadata} metadata
 * @returns {Promise<{dataManifestUrls: string[], deleteManifestUrls: string[]}>}
 */
export async function fetchManifestUrls(metadata) {
  const currentSnapshotId = metadata['current-snapshot-id']
  if (!currentSnapshotId || currentSnapshotId < 0) {
    throw new Error('No current snapshot id found in table metadata')
  }
  const snapshot = metadata.snapshots.find(s => s['snapshot-id'] === currentSnapshotId)
  if (!snapshot) {
    throw new Error(`Snapshot ${currentSnapshotId} not found in metadata`)
  }

  // Get manifest URLs from snapshot
  let manifestUrls = []
  if (snapshot['manifest-list']) {
    // Fetch manifest list and extract manifest URLs
    const manifestListUrl = snapshot['manifest-list']
    const records = /** @type {Manifest[]} */ (await fetchAvroRecords(manifestListUrl))
    manifestUrls = records.map(rec => rec.manifest_path)
  } else if (snapshot.manifests) {
    manifestUrls = snapshot.manifests.map(m => m.manifest_path)
  } else {
    throw new Error('No manifest information found in snapshot')
  }

  // Separate manifest URLs into data and delete manifests
  const dataManifestUrls = []
  const deleteManifestUrls = []
  for (const url of manifestUrls) {
    const records = /** @type {ManifestEntry[]} */ (await fetchAvroRecords(url))
    if (records.length === 0) continue
    const content = records[0].data_file.content || 0
    if (content === 0) {
      dataManifestUrls.push(url)
    } else if (content === 1 || content === 2) {
      deleteManifestUrls.push(url)
    }
  }

  return { dataManifestUrls, deleteManifestUrls }
}

/**
 * Fetches data files information from multiple manifest file URLs.
 *
 * @import {DataFile} from './types.js'
 * @param {string[]} manifestUrls - The URLs of the manifest files
 * @returns {Promise<DataFile[]>} Array of data file information
 */
export async function fetchDataFilesFromManifests(manifestUrls) {
  /** @type {DataFile[]} */
  const files = []
  for (const url of manifestUrls) {
    const records = await fetchAvroRecords(url)
    for (const rec of records) {
      files.push(rec.data_file)
    }
  }
  return files
}

/**
 * Reads delete files from delete manifests and groups them by target data file.
 *
 * @import {FilePositionDelete} from './types.js'
 * @param {string[]} deleteManifestUrls
 * @returns {Promise<{positionDeletesMap: Map<string, Set<bigint>>, equalityDeletesMap: Map<string, FilePositionDelete[]>}>}
 */
export async function fetchDeleteMaps(deleteManifestUrls) {
  // Read delete file info from delete manifests
  const deleteFiles = deleteManifestUrls.length > 0
    ? await fetchDataFilesFromManifests(deleteManifestUrls)
    : []

  // Build maps of delete entries keyed by target data file path
  /** @type {Map<string, Set<bigint>>} */
  const positionDeletesMap = new Map()
  /** @type {Map<string, FilePositionDelete[]>} */
  const equalityDeletesMap = new Map()

  // Fetch delete files in parallel
  await Promise.all(deleteFiles.map(async deleteFile => {
    const asyncBuffer = await asyncBufferFromUrl({ url: translateS3Url(deleteFile.file_path) })
    const file = cachedAsyncBuffer(asyncBuffer)
    const deleteRows = /** @type {FilePositionDelete[]} */ (await parquetReadObjects({ file, compressors }))
    for (const deleteRow of deleteRows) {
      const targetFile = deleteRow.file_path
      if (!targetFile) continue
      if (deleteFile.content === 1) { // Position delete
        const { pos } = deleteRow
        if (pos !== undefined && pos !== null) {
          // Note: pos is relative to the data file's row order
          let set = positionDeletesMap.get(targetFile)
          if (!set) {
            set = new Set()
            positionDeletesMap.set(targetFile, set)
          }
          set.add(pos)
        }
      } else if (deleteFile.content === 2) { // Equality delete
        // Save the entire delete row (restrict this to equalityIds?)
        let list = equalityDeletesMap.get(targetFile)
        if (!list) {
          list = []
          equalityDeletesMap.set(targetFile, list)
        }
        list.push(deleteRow)
      }
    }
  }))

  return { positionDeletesMap, equalityDeletesMap }
}

/**
 * Decodes Avro records from a url.
 *
 * @param {string} manifestUrl - The URL of the manifest file
 * @returns {Promise<Record<string, any>[]>} The decoded Avro records
 */
export async function fetchAvroRecords(manifestUrl) {
  const safeUrl = translateS3Url(manifestUrl)
  const buffer = await fetch(safeUrl).then(res => res.arrayBuffer())
  const reader = { view: new DataView(buffer), offset: 0 }
  const { metadata, syncMarker } = await avroMetadata(reader)
  return await avroData({ reader, metadata, syncMarker })
}
