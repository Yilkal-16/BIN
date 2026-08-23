// In-memory Mongoose mock for the Jest suite (Jest's __mocks__ convention —
// activated per-test-file via `jest.mock('mongoose')`, never used in
// production). Real behavior needing multi-document transactions or
// genuine MongoDB semantics still needs a manual smoke test against Atlas
// (see README) — this exists so query-correctness bugs (wrong filter
// shape, wrong field name, accidental duplicate object keys, etc.) get
// caught by `npm test` instead of only in production. That's exactly the
// class of bug this file's existence is currently guarding against: see
// tests/countSold.test.js.
//
// Fidelity detail: the canonical store holds PLAIN objects. find/findOne/
// findById return a FRESH Model instance cloned from the store on every
// call (like a real ODM hydrating a new Document per query), so a "before"
// snapshot taken earlier in a test can't silently mutate into the "after"
// value just because JS held the same object reference. .save() writes the
// instance's current fields back into the store.

let idCounter = 1;
function newId() {
  return `stub_${idCounter++}_${Math.random().toString(36).slice(2, 8)}`;
}

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function matches(doc, filter) {
  return Object.entries(filter || {}).every(([key, cond]) => {
    const val = get(doc, key);
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && cond.constructor === Object) {
      return Object.entries(cond).every(([op, opVal]) => {
        switch (op) {
          case '$ne': return val !== opVal;
          case '$in': return opVal.includes(val);
          case '$nin': return !opVal.includes(val);
          case '$gte': return val >= opVal;
          case '$lte': return val <= opVal;
          case '$gt': return val > opVal;
          case '$lt': return val < opVal;
          default: return true;
        }
      });
    }
    return val === cond;
  });
}

function applyUpdate(doc, update, isNewInsert) {
  if (update.$set) Object.assign(doc, update.$set);
  if (update.$setOnInsert && isNewInsert) Object.assign(doc, update.$setOnInsert);
  if (update.$inc) {
    for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + v;
  }
  const plain = { ...update };
  delete plain.$set;
  delete plain.$inc;
  delete plain.$setOnInsert;
  Object.assign(doc, plain);
  return doc;
}

function sortDocs(docs, sortSpec) {
  if (!sortSpec) return docs;
  const entries = Object.entries(sortSpec);
  return [...docs].sort((a, b) => {
    for (const [key, dir] of entries) {
      const av = get(a, key);
      const bv = get(b, key);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
    }
    return 0;
  });
}

class Schema {
  constructor(def, opts) { this.def = def; this.opts = opts; this._indexes = []; this._pre = {}; }
  index() { this._indexes.push([...arguments]); return this; }
  pre(hook, fn) { this._pre[hook] = fn; return this; }
  static get Types() { return { ObjectId: 'ObjectId', Mixed: 'Mixed' }; }
}
Schema.Types = { ObjectId: 'ObjectId', Mixed: 'Mixed' };

function makeChainable(getResultsFn, opts) {
  opts = opts || {};
  const single = opts.single;
  const state = { sort: null, skip: 0, limit: null, lean: false, populate: [] };
  const api = {
    sort(spec) { state.sort = spec; return api; },
    skip(n) { state.skip = n; return api; },
    limit(n) { state.limit = n; return api; },
    select() { return api; },
    lean() { state.lean = true; return api; },
    session() { return api; },
    populate(field) { state.populate.push(field); return api; },
    then(resolve, reject) {
      try {
        let results = getResultsFn();
        results = sortDocs(results, state.sort);
        if (state.skip) results = results.slice(state.skip);
        if (state.limit != null) results = results.slice(0, state.limit);
        const out = single ? (results[0] !== undefined ? results[0] : null) : results;
        resolve(out);
      } catch (err) {
        if (reject) reject(err); else throw err;
      }
    },
    catch(reject) { return api.then(() => {}, reject); }
  };
  return api;
}

function makeModel(name) {
  const store = new Map(); // _id -> PLAIN object (canonical persisted state)

  function Model(doc) {
    Object.assign(this, doc);
    if (!this._id) this._id = newId();
  }
  Model.modelName = name;
  Model._store = store;

  function hydrate(plainDoc) {
    return new Model(clone(plainDoc));
  }

  Model.find = function (filter) {
    filter = filter || {};
    return makeChainable(function () {
      return [...store.values()].filter(function (d) { return matches(d, filter); }).map(hydrate);
    });
  };
  Model.findOne = function (filter) {
    filter = filter || {};
    return makeChainable(function () {
      return [...store.values()].filter(function (d) { return matches(d, filter); }).map(hydrate);
    }, { single: true });
  };
  Model.findById = function (id) {
    return makeChainable(function () {
      return [...store.values()].filter(function (d) { return d._id === id; }).map(hydrate);
    }, { single: true });
  };

  Model.findOneAndUpdate = async function (filter, update, opts) {
    opts = opts || {};
    let plain = [...store.values()].find(function (d) { return matches(d, filter); });
    let isNewInsert = false;
    let preUpdateSnapshot = null;
    if (!plain) {
      if (opts.upsert) {
        isNewInsert = true;
        plain = clone(filter);
        if (!plain._id) plain._id = newId();
        store.set(plain._id, plain);
      } else {
        return null;
      }
    } else {
      preUpdateSnapshot = clone(plain);
    }
    applyUpdate(plain, update, isNewInsert);
    store.set(plain._id, plain);
    if (opts.new === false) {
      // Real Mongoose: with upsert+new:false, a fresh insert returns null
      // (there is no "before" document); an existing doc returns its
      // pre-update snapshot.
      return isNewInsert ? null : hydrate(preUpdateSnapshot);
    }
    return hydrate(plain);
  };
  Model.findByIdAndUpdate = function (id, update, opts) {
    return Model.findOneAndUpdate({ _id: id }, update, opts);
  };

  Model.updateOne = function (filter, update) {
    const p = (async function () {
      const plain = [...store.values()].find(function (d) { return matches(d, filter); });
      if (plain) {
        applyUpdate(plain, update);
        store.set(plain._id, plain);
      }
      return { acknowledged: true, matchedCount: plain ? 1 : 0 };
    })();
    p.session = function () { return p; };
    return p;
  };

  Model.create = async function (doc) {
    function build(d) {
      const instance = new Model(clone(d));
      store.set(instance._id, clone(instance));
      return instance;
    }
    return Array.isArray(doc) ? doc.map(build) : build(doc);
  };
  Model.insertMany = async function (docs) {
    return docs.map(function (d) {
      const instance = new Model(clone(d));
      store.set(instance._id, clone(instance));
      return instance;
    });
  };
  Model.countDocuments = async function (filter) {
    filter = filter || {};
    return [...store.values()].filter(function (d) { return matches(d, filter); }).length;
  };
  Model.deleteMany = async function (filter) {
    filter = filter || {};
    [...store.values()].filter(function (d) { return matches(d, filter); }).forEach(function (d) { store.delete(d._id); });
  };

  Model.prototype.save = async function save() {
    store.set(this._id, clone(this));
    return this;
  };
  Model.prototype.toObject = function toObject() {
    return clone(this);
  };

  return Model;
}

const modelRegistry = {};

const mongooseStub = {
  Schema: Schema,
  connection: { readyState: 0, on: function () {} },
  set: function () {},
  connect: async function () { return { connection: { name: 'stub' } }; },
  disconnect: async function () {},
  model: function (name) {
    if (!modelRegistry[name]) modelRegistry[name] = makeModel(name);
    return modelRegistry[name];
  },
  models: new Proxy({}, { get: function (_t, name) { return modelRegistry[name]; } }),
  startSession: async function () {
    return {
      withTransaction: async function (fn) { return fn(); },
      endSession: function () {}
    };
  },
  _registry: modelRegistry
};
module.exports = mongooseStub;
