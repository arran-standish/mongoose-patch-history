import assert from 'assert'
import jsonpatch from 'fast-json-patch'
import { each, get, merge, omit, tail } from 'lodash'

const createPatchModel = (options) => {
  const def = {
    date: { type: Date, required: true, default: Date.now },
    ops: { type: [], required: true },
    ref: { type: options._idType, required: true, index: true },
  }

  each(options.includes, (type, name) => {
    def[name] = omit(type, 'from')
  })

  const PatchSchema = new options.schema(def)

  return options.mongoose.model(
    options.name,
    PatchSchema,
    options.name[0].toLowerCase() + options.name.substring(1)
  )
}

const defaultOptions = {
  includes: {},
  excludes: [],
  removePatches: true,
  trackOriginalValue: false,
}

// used to convert bson to json - especially ObjectID references need
// to be converted to hex strings so that the jsonpatch `compare` method
// works correctly
const toJSON = (obj) => JSON.parse(JSON.stringify(obj))

// helper function to merge query conditions after an update has happened
// usefull if a property which was initially defined in _conditions got overwritten
// with the update
const mergeQueryConditionsWithUpdate = (_conditions, _update) => {
  const update = _update ? _update.$set || _update : _update
  const conditions = Object.assign({}, conditions, update)

  // excluding updates other than $set
  Object.keys(conditions).forEach((key) => {
    if (key.includes('$')) delete conditions[key]
  })
  return conditions
}

export default function (schema, opts) {
  const options = merge({}, defaultOptions, opts)

  // get _id type from schema
  options._idType = schema.tree._id.type

  // validate parameters
  assert(options.mongoose, '`mongoose` option must be defined')
  assert(options.name, '`name` option must be defined')
  assert(!schema.methods.data, 'conflicting instance method: `data`')
  assert(options._idType, 'schema is missing an `_id` property')

  // used to compare instance data snapshots. depopulates instance,
  // removes version key and object id
  schema.methods.data = function () {
    return this.toObject({
      depopulate: true,
      versionKey: false,
      transform: (doc, ret, options) => {
        delete ret._id
        // if timestamps option is set on schema, ignore timestamp fields
        if (schema.options.timestamps) {
          delete ret[schema.options.timestamps.createdAt || 'createdAt']
          delete ret[schema.options.timestamps.updatedAt || 'updatedAt']
        }
      },
    })
  }

  // create patch model, enable static model access via `Patches` and
  // instance method access through an instances `patches` property
  const Patches = createPatchModel(options)
  schema.statics.Patches = Patches
  schema.virtual('patches').get(() => Patches)

  // after a document is initialized or saved, fresh snapshots of the
  // documents data are created
  const snapshot = function () {
    this._original = toJSON(this.data())
  }
  schema.post('init', snapshot)
  schema.post('save', snapshot)

  // when a document is removed and `removePatches` is not set to false ,
  // all patch documents from the associated patch collection are also removed
  function deletePatches(document) {
    const { _id: ref } = document
    return document.patches
      .find({ ref: document._id })
      .then((patches) => Promise.all(patches.map((patch) => patch.remove())))
  }

  schema.pre('remove', function (next) {
    if (!options.removePatches) {
      return next()
    }

    deletePatches(this)
      .then(() => next())
      .catch(next)
  })

  // when a document is saved, the json patch that reflects the changes is
  // computed. if the patch consists of one or more operations (meaning the
  // document has changed), a new patch document reflecting the changes is
  // added to the associated patch collection
  function createPatch(document, queryOptions = {}) {
    const { _id: ref } = document
    let ops = jsonpatch.compare(
      document.isNew ? {} : document._original || {},
      toJSON(document.data())
    )

    // don't save a patch when there are no changes to save
    if (!ops.length) {
      return Promise.resolve()
    }

    // track original values if enabled
    if (options.trackOriginalValue) {
      ops.map((entry) => {
        const path = tail(entry.path.split('/')).join('.')
        entry.originalValue = get(
          document.isNew ? {} : document._original,
          path
        )
      })
    }

    // assemble patch data
    const data = { ops, ref }
    each(options.includes, (type, name) => {
      data[name] =
        document[type.from || name] || queryOptions[type.from || name]
    })

    return document.patches.create(data)
  }

  schema.pre('save', function (next) {
    createPatch(this)
      .then(() => next())
      .catch(next)
  })

  schema.pre('findOneAndRemove', function (next) {
    if (!options.removePatches) {
      return next()
    }

    this.model
      .findOne(this._conditions)
      .then((original) => deletePatches(original))
      .then(() => next())
      .catch(next)
  })

  schema.pre('findOneAndUpdate', preUpdateOne)

  function preUpdateOne(next) {
    this.model
      .findOne(this._conditions)
      .then((original) => {
        if (original) this._originalId = original._id
        original = original || new this.model({})
        this._original = toJSON(original.data())
      })
      .then(() => next())
      .catch(next)
  }

  schema.post('findOneAndUpdate', function (doc, next) {
    return postUpdateOne.call(this, {}, next)
  })

  function postUpdateOne(result, next) {
    if (result.nModified === 0 && !result.upserted) return next()

    let conditions
    if (this._originalId) conditions = { _id: { $eq: this._originalId } }
    else
      conditions = mergeQueryConditionsWithUpdate(
        this._conditions,
        this._update
      )

    this.model
      .findOne(conditions)
      .then((doc) => {
        if (!doc) return next()
        doc._original = this._original
        return createPatch(doc, this.options)
      })
      .then(() => next())
      .catch(next)
  }

  schema.pre('updateOne', preUpdateOne)
  schema.post('updateOne', postUpdateOne)

  function preUpdateMany(next) {
    this.model
      .find(this._conditions)
      .then((originals) => {
        const originalIds = []
        const originalData = []
        for (const original of originals) {
          originalIds.push(original._id)
          originalData.push(toJSON(original.data()))
        }
        this._originalIds = originalIds
        this._originals = originalData
      })
      .then(() => next())
      .catch(next)
  }

  function postUpdateMany(result, next) {
    if (result.nModified === 0 && !result.upserted) return next()

    let conditions
    if (this._originalIds.length === 0)
      conditions = mergeQueryConditionsWithUpdate(
        this._conditions,
        this._update
      )
    else conditions = { _id: { $in: this._originalIds } }

    this.model
      .find(conditions)
      .then((docs) =>
        Promise.all(
          docs.map((doc, i) => {
            doc._original = this._originals[i]
            return createPatch(doc, this.options)
          })
        )
      )
      .then(() => next())
      .catch(next)
  }

  schema.pre('updateMany', preUpdateMany)
  schema.post('updateMany', postUpdateMany)

  schema.pre('update', function (next) {
    if (this.options.multi) {
      preUpdateMany.call(this, next)
    } else {
      preUpdateOne.call(this, next)
    }
  })
  schema.post('update', function (result, next) {
    if (this.options.multi) {
      postUpdateMany.call(this, result, next)
    } else {
      postUpdateOne.call(this, result, next)
    }
  })
}
