/*
 * Minio Javascript Library for Amazon S3 Compatible Cloud Storage, (C) 2016 Minio, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import through2 from 'through2'
import crypto from 'crypto'

import { isValidPrefix, isValidEndpoint, isValidBucketName,
         isValidPort, isValidObjectName, isAmazonEndpoint, getScope,
         uriEscape, uriResourceEscape, isBoolean, isFunction, isNumber,
         isString, isObject, isNullOrUndefined, pipesetup,
         readableStream, isReadableStream, isVirtualHostStyle } from './helpers.js';

export default function chunkUploader(client, bucketName, objectName, contentType, uploadId, partsArray, multipartSize) {
  if (!isValidBucketName(bucketName)) {
    throw new errors.InvalidBucketNameError(`Invalid bucket name: ${bucketName}`)
  }
  if (!isValidObjectName(objectName)) {
    throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`)
  }
  if (!isString(contentType)) {
    throw new TypeError('contentType should be of type "string"')
  }
  if (!isString(uploadId)) {
    throw new TypeError('uploadId should be of type "string"')
  }
  if (!isObject(partsArray)) {
    throw new TypeError('partsArray should be of type "Array"')
  }
  if (!isNumber(multipartSize)) {
    throw new TypeError('multipartSize should be of type "number"')
  }
  if (multipartSize > client.maximumPartSize) {
    throw new errors.InvalidArgumentError(`multipartSize cannot be more than ${client.maximumPartSize}`)
  }
  var partsDone = []
  var partNumber = 1

  // convert array to object to make things easy
  var parts = partsArray.reduce(function(acc, item) {
    if (!acc[item.part]) {
      acc[item.part] = item
    }
    return acc
  }, {})

  var aggregatedSize = 0

  var aggregator = null   // aggregator is a simple through stream that aggregates
                          // chunks of minimumPartSize adding up to multipartSize

  var md5 = null
  var sha256 = null
  return through2.obj((chunk, enc, cb) => {
    if (chunk.length > client.minimumPartSize) {
      return cb(new Error(`chunk length cannot be more than ${client.minimumPartSize}`))
    }

    // get new objects for a new part upload
    if (!aggregator) aggregator = through2()
    if (!md5) md5 = crypto.createHash('md5')
    if (!sha256 && client.enableSHA256) sha256 = crypto.createHash('sha256')

    aggregatedSize += chunk.length
    if (aggregatedSize > multipartSize) return cb(new Error('aggregated size cannot be greater than multipartSize'))

    aggregator.write(chunk)
    md5.update(chunk)
    if (client.enableSHA256) sha256.update(chunk)

    var done = false
    if (aggregatedSize === multipartSize) done = true
    // This is the last chunk of the stream.
    if (aggregatedSize < multipartSize && chunk.length < client.minimumPartSize) done = true

    // more chunks are expected
    if (!done) return cb()

    aggregator.end() // when aggregator is piped to another stream it emits all the chunks followed by 'end'

    var part = parts[partNumber]
    var md5sumHex = md5.digest('hex')
    if (part) {
      if (md5sumHex === part.etag) {
        // md5 matches, chunk already uploaded
        // reset aggregator md5 sha256 and aggregatedSize variables for a fresh multipart upload
        aggregator = md5 = sha256 = null
        aggregatedSize = 0
        partsDone.push({part: part.part, etag: part.etag})
        partNumber++
        return cb()
      }
      // md5 doesn't match, upload again
    }
    var sha256sum = ''
    if (client.enableSHA256) sha256sum = sha256.digest('hex')
    var md5sumBase64 = (new Buffer(md5sumHex, 'hex')).toString('base64')
    var multipart = true
    var uploader = client.getUploader(bucketName, objectName, contentType, multipart)
    uploader(uploadId, partNumber, aggregator, aggregatedSize, sha256sum, md5sumBase64, (e, etag) => {
      if (e) {
        return cb(e)
      }
      // reset aggregator md5 sha256 and aggregatedSize variables for a fresh multipart upload
      aggregator = md5 = sha256 = null
      aggregatedSize = 0
      var part = {
        part: partNumber,
        etag: etag
      }
      partsDone.push(part)
      partNumber++
      cb()
    })
  }, function(cb) {
    this.push(partsDone)
    this.push(null)
    cb()
  })
}