'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

exports.default = function (schema, opts) {
  var options = (0, _lodash.merge)({}, defaultOptions, opts);

  // get _id type from schema
  options._idType = schema.tree._id.type;

  // validate parameters
  (0, _assert2.default)(options.mongoose, '`mongoose` option must be defined');
  (0, _assert2.default)(options.name, '`name` option must be defined');
  (0, _assert2.default)(!schema.methods.data, 'conflicting instance method: `data`');
  (0, _assert2.default)(options._idType, 'schema is missing an `_id` property');

  // used to compare instance data snapshots. depopulates instance,
  // removes version key and object id
  schema.methods.data = function () {
    return this.toObject({
      depopulate: true,
      versionKey: false,
      transform: function transform(doc, ret, options) {
        delete ret._id;
        // if timestamps option is set on schema, ignore timestamp fields
        if (schema.options.timestamps) {
          delete ret[schema.options.timestamps.createdAt || 'createdAt'];
          delete ret[schema.options.timestamps.updatedAt || 'updatedAt'];
        }
      }
    });
  };

  // create patch model, enable static model access via `Patches` and
  // instance method access through an instances `patches` property
  var Patches = createPatchModel(options);
  schema.statics.Patches = Patches;
  schema.virtual('patches').get(function () {
    return Patches;
  });

  // after a document is initialized or saved, fresh snapshots of the
  // documents data are created
  var snapshot = function snapshot() {
    this._original = toJSON(this.data());
  };
  schema.post('init', snapshot);
  schema.post('save', snapshot);

  // when a document is removed and `removePatches` is not set to false ,
  // all patch documents from the associated patch collection are also removed
  function deletePatches(document) {
    var ref = document._id;

    return document.patches.find({ ref: document._id }).then(function (patches) {
      return Promise.all(patches.map(function (patch) {
        return patch.remove();
      }));
    });
  }

  schema.pre('remove', function (next) {
    if (!options.removePatches) {
      return next();
    }

    deletePatches(this).then(function () {
      return next();
    }).catch(next);
  });

  // when a document is saved, the json patch that reflects the changes is
  // computed. if the patch consists of one or more operations (meaning the
  // document has changed), a new patch document reflecting the changes is
  // added to the associated patch collection
  function createPatch(document) {
    var queryOptions = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
    var ref = document._id;

    var ops = _fastJsonPatch2.default.compare(document.isNew ? {} : document._original || {}, toJSON(document.data()));

    // don't save a patch when there are no changes to save
    if (!ops.length) {
      return Promise.resolve();
    }

    // track original values if enabled
    if (options.trackOriginalValue) {
      ops.map(function (entry) {
        var path = (0, _lodash.tail)(entry.path.split('/')).join('.');
        entry.originalValue = (0, _lodash.get)(document.isNew ? {} : document._original, path);
      });
    }

    // assemble patch data
    var data = { ops: ops, ref: ref };
    (0, _lodash.each)(options.includes, function (type, name) {
      data[name] = document[type.from || name] || queryOptions[type.from || name];
    });

    return document.patches.create(data);
  }

  schema.pre('save', function (next) {
    createPatch(this).then(function () {
      return next();
    }).catch(next);
  });

  schema.pre('findOneAndRemove', function (next) {
    if (!options.removePatches) {
      return next();
    }

    this.model.findOne(this._conditions).then(function (original) {
      return deletePatches(original);
    }).then(function () {
      return next();
    }).catch(next);
  });

  schema.pre('findOneAndUpdate', preUpdateOne);

  function preUpdateOne(next) {
    var _this = this;

    this.model.findOne(this._conditions).then(function (original) {
      if (original) _this._originalId = original._id;
      original = original || new _this.model({});
      _this._original = toJSON(original.data());
    }).then(function () {
      return next();
    }).catch(next);
  }

  schema.post('findOneAndUpdate', function (doc, next) {
    return postUpdateOne.call(this, {}, next);
  });

  function postUpdateOne(result, next) {
    var _this2 = this;

    if (result.nModified === 0 && !result.upserted) return next();

    var conditions = void 0;
    if (this._originalId) conditions = { _id: { $eq: this._originalId } };else conditions = mergeQueryConditionsWithUpdate(this._conditions, this._update);

    this.model.findOne(conditions).then(function (doc) {
      if (!doc) return next();
      doc._original = _this2._original;
      return createPatch(doc, _this2.options);
    }).then(function () {
      return next();
    }).catch(next);
  }

  schema.pre('updateOne', preUpdateOne);
  schema.post('updateOne', postUpdateOne);

  function preUpdateMany(next) {
    var _this3 = this;

    this.model.find(this._conditions).then(function (originals) {
      var originalIds = [];
      var originalData = [];
      var _iteratorNormalCompletion = true;
      var _didIteratorError = false;
      var _iteratorError = undefined;

      try {
        for (var _iterator = originals[Symbol.iterator](), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
          var original = _step.value;

          originalIds.push(original._id);
          originalData.push(toJSON(original.data()));
        }
      } catch (err) {
        _didIteratorError = true;
        _iteratorError = err;
      } finally {
        try {
          if (!_iteratorNormalCompletion && _iterator.return) {
            _iterator.return();
          }
        } finally {
          if (_didIteratorError) {
            throw _iteratorError;
          }
        }
      }

      _this3._originalIds = originalIds;
      _this3._originals = originalData;
    }).then(function () {
      return next();
    }).catch(next);
  }

  function postUpdateMany(result, next) {
    var _this4 = this;

    if (result.nModified === 0 && !result.upserted) return next();

    var conditions = void 0;
    if (this._originalIds.length === 0) conditions = mergeQueryConditionsWithUpdate(this._conditions, this._update);else conditions = { _id: { $in: this._originalIds } };

    this.model.find(conditions).then(function (docs) {
      return Promise.all(docs.map(function (doc, i) {
        doc._original = _this4._originals[i];
        return createPatch(doc, _this4.options);
      }));
    }).then(function () {
      return next();
    }).catch(next);
  }

  schema.pre('updateMany', preUpdateMany);
  schema.post('updateMany', postUpdateMany);

  schema.pre('update', function (next) {
    if (this.options.multi) {
      preUpdateMany.call(this, next);
    } else {
      preUpdateOne.call(this, next);
    }
  });
  schema.post('update', function (result, next) {
    if (this.options.multi) {
      postUpdateMany.call(this, result, next);
    } else {
      postUpdateOne.call(this, result, next);
    }
  });
};

var _assert = require('assert');

var _assert2 = _interopRequireDefault(_assert);

var _fastJsonPatch = require('fast-json-patch');

var _fastJsonPatch2 = _interopRequireDefault(_fastJsonPatch);

var _lodash = require('lodash');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var createPatchModel = function createPatchModel(options) {
  var def = {
    date: { type: Date, required: true, default: Date.now },
    ops: { type: [], required: true },
    ref: { type: options._idType, required: true, index: true }
  };

  (0, _lodash.each)(options.includes, function (type, name) {
    def[name] = (0, _lodash.omit)(type, 'from');
  });

  var PatchSchema = new options.schema(def);

  return options.mongoose.model(options.name, PatchSchema, options.name[0].toLowerCase() + options.name.substring(1));
};

var defaultOptions = {
  includes: {},
  excludes: [],
  removePatches: true,
  trackOriginalValue: false

  // used to convert bson to json - especially ObjectID references need
  // to be converted to hex strings so that the jsonpatch `compare` method
  // works correctly
};var toJSON = function toJSON(obj) {
  return JSON.parse(JSON.stringify(obj));
};

// helper function to merge query conditions after an update has happened
// usefull if a property which was initially defined in _conditions got overwritten
// with the update
var mergeQueryConditionsWithUpdate = function mergeQueryConditionsWithUpdate(_conditions, _update) {
  var update = _update ? _update.$set || _update : _update;
  var conditions = Object.assign({}, conditions, update);

  // excluding updates other than $set
  Object.keys(conditions).forEach(function (key) {
    if (key.includes('$')) delete conditions[key];
  });
  return conditions;
};