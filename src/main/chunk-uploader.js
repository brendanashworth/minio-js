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
import { Transform } from 'stream'

import { isValidBucketName, isValidObjectName, isNumber, isString,
         isObject } from './helpers.js';

export default class ChunkUploader extends Transform {

  constructor(client, bucketName, objectName, contentType, uploadId, partsArray, multipartSize) {
    super({
      objectMode: true
    })

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

    this.client = client
    this.bucketName = bucketName
    this.objectName = objectName
    this.contentType = contentType
    this.uploadId = uploadId
    this.multipartSize = multipartSize

    this.partsDone = []
    this.partNumber = 1

    // convert array to object to make things easy
    this.parts = partsArray.reduce(function(acc, item) {
      if (!acc[item.part]) {
        acc[item.part] = item
      }
      return acc
    }, {})

    this.aggregatedSize = 0

    this.aggregator = null   // aggregator is a simple through stream that aggregates
                             // chunks of minimumPartSize adding up to multipartSize

    this.md5 = null
    this.sha256 = null
  }

  _write(chunk, enc, cb) {
      if (chunk.length > this.client.minimumPartSize) {
        return cb(new Error(`chunk length cannot be more than ${this.client.minimumPartSize}`))
      }

      // get new objects for a new part upload
      if (!this.aggregator) this.aggregator = through2()
      if (!this.md5) this.md5 = crypto.createHash('md5')
      if (!this.sha256 && this.client.enableSHA256) this.sha256 = crypto.createHash('sha256')

      this.aggregatedSize += chunk.length
      if (this.aggregatedSize > this.multipartSize) return cb(new Error('aggregated size cannot be greater than multipartSize'))

      this.aggregator.write(chunk)
      this.md5.update(chunk)
      if (this.client.enableSHA256) this.sha256.update(chunk)

      var done = false
      if (this.aggregatedSize === this.multipartSize) done = true
      // This is the last chunk of the stream.
      if (this.aggregatedSize < this.multipartSize && chunk.length < this.client.minimumPartSize) done = true

      // more chunks are expected
      if (!done) return cb()

      this.aggregator.end() // when aggregator is piped to another stream it emits all the chunks followed by 'end'

      var part = this.parts[this.partNumber]
      var md5sumHex = this.md5.digest('hex')
      if (part) {
        if (md5sumHex === part.etag) {
          // md5 matches, chunk already uploaded
          // reset aggregator md5 sha256 and aggregatedSize variables for a fresh multipart upload
          this.aggregator = this.md5 = this.sha256 = null
          this.aggregatedSize = 0
          this.partsDone.push({part: part.part, etag: part.etag})
          this.partNumber++
          return cb()
        }
        // md5 doesn't match, upload again
      }
      var sha256sum = ''
      if (this.client.enableSHA256) sha256sum = this.sha256.digest('hex')
      var md5sumBase64 = (new Buffer(md5sumHex, 'hex')).toString('base64')
      var multipart = true
      var uploader = this.client.getUploader(this.bucketName, this.objectName, this.contentType, multipart)
      uploader(this.uploadId, this.partNumber, this.aggregator, this.aggregatedSize, sha256sum, md5sumBase64, (e, etag) => {
        if (e) {
          return cb(e)
        }
        // reset aggregator md5 sha256 and aggregatedSize variables for a fresh multipart upload
        this.aggregator = this.md5 = this.sha256 = null
        this.aggregatedSize = 0
        var part = {
          part: this.partNumber,
          etag: etag
        }
        this.partsDone.push(part)
        this.partNumber++
        cb()
      })
    }

    _flush(cb) { // TODO FIX?? no flush on writable
      this.push(this.partsDone)
      this.push(null)
      cb()
    }

}
