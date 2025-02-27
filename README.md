A fork of the Mongoose Patch History to work with mongoose v6.x and up. Note that it has removed functionality related to rollbacks and excludes (as I did not require it)

See the original project [repo](https://github.com/codepunkt/mongoose-patch-history) for more details and possible updates.

## Installation

    $ npm install mongoose-patch-audit

## Usage

To use **mongoose-patch-audit** for an existing mongoose schema you can simply plug it in. As an example, the following schema definition defines a `Post` schema, and uses mongoose-patch-audit with default options:

```javascript
import mongoose, { Schema } from 'mongoose'
import patchHistory from 'mongoose-patch-audit'

const PostSchema = new Schema({
  title: { type: String, required: true },
  comments: Array,
})

PostSchema.plugin(patchHistory, { mongoose, schema: Schema, name: 'postPatches' })
const Post = mongoose.model('Post', PostSchema)
```

**mongoose-patch-audit** will define a schema that has a `ref` field containing the `ObjectId` of the original document, a `ops` array containing all json patch operations and a `date` field storing the date where the patch was applied.

### Storing a new document

Continuing the previous example, a new patch is added to the associated patch collection whenever a new post is added to the posts collection:

```javascript
Post.create({ title: 'JSON patches' })
  .then(post => post.patches.findOne({ ref: post.id }))
  .then(console.log)

// {
//   _id: ObjectId('4edd40c86762e0fb12000003'),
//   ref: ObjectId('4edd40c86762e0fb12000004'),
//   ops: [
//     { value: 'JSON patches', path: '/title', op: 'add' },
//     { value: [], path: '/comments', op: 'add' }
//   ],
//   date: new Date(1462360838107),
//   __v: 0
// }
```

### Updating an existing document

**mongoose-patch-audit** also adds a static field `Patches` to the model that can be used to access the patch model associated with the model, for example to query all patches of a document. Whenever a post is edited, a new patch that reflects the update operation is added to the associated patch collection:

```javascript
const data = {
  title: 'JSON patches with mongoose',
  comments: [{ message: 'Wow! Such Mongoose! Very NoSQL!' }],
}

Post.create({ title: 'JSON patches' })
  .then(post => post.set(data).save())
  .then(post => post.patches.find({ ref: post.id }))
  .then(console.log)

// [{
//   _id: ObjectId('4edd40c86762e0fb12000003'),
//   ref: ObjectId('4edd40c86762e0fb12000004'),
//   ops: [
//     { value: 'JSON patches', path: '/title', op: 'add' },
//     { value: [], path: '/comments', op: 'add' }
//   ],
//   date: new Date(1462360838107),
//   __v: 0
// }, {
//   _id: ObjectId('4edd40c86762e0fb12000005'),
//   ref: ObjectId('4edd40c86762e0fb12000004'),
//   ops: [
//     { value: { message: 'Wow! Such Mongoose! Very NoSQL!' }, path: '/comments/0', op: 'add' },
//     { value: 'JSON patches with mongoose', path: '/title', op: 'replace' }
//   ],
//   "date": new Date(1462361848742),
//   "__v": 0
// }]
```
## Options

```javascript
import {Schema} from 'mongoose'

PostSchema.plugin(patchHistory, {
  mongoose,
  name: 'postPatches',
  schema: Schema
})
```

- `mongoose` :pushpin: _required_ <br/>
  The mongoose instance to work with
- `name` :pushpin: _required_ <br/>
  String where the names of both patch model and patch collection are generated from. By default, model name is the pascalized version and collection name is an undercore separated version
- `schema` :pushpin: _required_ <br/>
  the mongoose Schema object used to create the patches Schema for creating the mongoose model
- `removePatches` <br/>
  Removes patches when origin document is removed. Default: `true`
- `includes` <br/>
  Property definitions that will be included in the patch schema. Read more about includes in the next chapter of the documentation. Default: `{}`
- `trackOriginalValue` <br/>
  If enabled, the original value will be stored in the change patches under the attribute `originalValue`. Default: `false`

### Includes

```javascript
PostSchema.plugin(patchHistory, {
  mongoose,
  name: 'postPatches',
  includes: {
    title: { type: String, required: true },
  },
})
```

This will add a `title` property to the patch schema. All options that are available in mongoose's schema property definitions such as `required`, `default` or `index` can be used.

```javascript
Post.create({ title: 'Included in every patch' })
  .then((post) => post.patches.findOne({ ref: post.id })
  .then((patch) => {
    console.log(patch.title) // 'Included in every patch'
  })
```

The value of the patch documents properties is read from the versioned documents property of the same name.

#### Reading from virtuals

There is an additional option that allows storing information in the patch documents that is not stored in the versioned documents. To do so, you can use a combination of [virtual type setters](http://mongoosejs.com/docs/guide.html#virtuals) on the versioned document and an additional `from` property in the include options of **mongoose-patch-history**:

```javascript
// save user as _user in versioned documents
PostSchema.virtual('user').set(function (user) {
  this._user = user
})

// read user from _user in patch documents
PostSchema.plugin(patchHistory, {
  mongoose,
  name: 'postPatches',
  includes: {
    user: { type: Schema.Types.ObjectId, required: true, from: '_user' },
  },
})

// create post, pass in user information
Post.create({
  title: 'Why is hiring broken?',
  user: mongoose.Types.ObjectId(),
})
  .then(post => {
    console.log(post.user) // undefined
    return post.patches.findOne({ ref: post.id })
  })
  .then(patch => {
    console.log(patch.user) // 4edd40c86762e0fb12000012
  })
```

#### Reading from query options

In situations where you are running Mongoose queries directly instead of via a document, you can specify the extra fields in the query options:

```javascript
Post.findOneAndUpdate(
  { _id: '4edd40c86762e0fb12000012' },
  { title: 'Why is hiring broken? (updated)' },
  { _user: mongoose.Types.ObjectId() }
)
```