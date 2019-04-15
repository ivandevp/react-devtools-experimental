// @flow

export function decorateResult(obj, attr, fn) {
  const old = obj[attr];
  obj[attr] = function(instance: NodeLike) {
    const res = old.apply(this, arguments);
    fn(res);
    return res;
  };
  return old;
}

export function decorate(obj, attr, fn) {
  const old = obj[attr];
  obj[attr] = function(instance: NodeLike) {
    const res = old.apply(this, arguments);
    fn.apply(this, arguments);
    return res;
  };
  return old;
}

export function decorateMany(source, fns) {
  const olds = {};
  for (const name in fns) {
    olds[name] = decorate(source, name, fns[name]);
  }
  return olds;
}

export function restoreMany(source, olds) {
  for (let name in olds) {
    source[name] = olds[name];
  }
}

export function forceUpdate(instance) {
  if (typeof instance.forceUpdate === 'function') {
    instance.forceUpdate();
  } else if (
    instance.updater != null &&
    typeof instance.updater.enqueueForceUpdate === 'function'
  ) {
    instance.updater.enqueueForceUpdate(this, () => {}, 'forceUpdate');
  }
}
