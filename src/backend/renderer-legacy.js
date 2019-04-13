// @flow

import {
  ElementTypeClass,
  ElementTypeFunction,
  ElementTypeEventComponent,
  ElementTypeEventTarget,
  ElementTypeOtherOrUnknown,
  ElementTypeRoot,
} from 'src/devtools/types';
import { getDisplayName, getUID, utfEncodeString } from '../utils';
import { cleanForBridge, copyWithSet, setInObject } from './utils';
import {
  __DEBUG__,
  LOCAL_STORAGE_RELOAD_AND_PROFILE_KEY,
  TREE_OPERATION_ADD,
  TREE_OPERATION_REMOVE,
  TREE_OPERATION_RESET_CHILDREN,
  TREE_OPERATION_RECURSIVE_REMOVE_CHILDREN,
  TREE_OPERATION_UPDATE_TREE_BASE_DURATION,
} from '../constants';

import type {
  DevToolsHook,
  NativeType,
  LegacyRendererInterface,
} from './types';
import type { InspectedElement } from 'src/devtools/views/Components/types';

type Id = any;
type InternalInstance = Object;
type LegacyRenderer = Object;

export function attach(
  hook: DevToolsHook,
  rendererID: number,
  renderer: LegacyRenderer,
  global: Object
): LegacyRendererInterface {
  const internalInstanceToIDMap: Map<InternalInstance, number> = new Map();
  const idToInternalInstanceMap: Map<number, InternalInstance> = new Map();

  function getID(internalInstance: InternalInstance): number {
    if (!internalInstanceToIDMap.has(internalInstance)) {
      const id = getUID();
      internalInstanceToIDMap.set(internalInstance, id);
      idToInternalInstanceMap.set(id, internalInstance);
    }
    return ((internalInstanceToIDMap.get(internalInstance): any): number);
  }

  // Before 0.13 there was no Reconciler, so we patch Component.Mixin
  const isPre013 = !renderer.Reconciler;

  // TODO The below get-native-from-internal and get-internal-from-native methods are probably broken.
  let getInternalIDFromNative: (
    component: NativeType,
    findNearestUnfilteredAncestor?: boolean
  ) => number | null = null;
  let getNativeFromInternal: (id: number) => ?NativeType = null;

  // React Native
  if (renderer.Mount.findNodeHandle && renderer.Mount.nativeTagToRootNodeID) {
    getInternalIDFromNative = (nativeTag, findNearestUnfilteredAncestor) =>
      renderer.Mount.nativeTagToRootNodeID(nativeTag);
    getNativeFromInternal = component =>
      renderer.Mount.findNodeHandle(component);

    // React DOM 15+
  } else if (renderer.ComponentTree) {
    getInternalIDFromNative = (node, findNearestUnfilteredAncestor) =>
      renderer.ComponentTree.getClosestInstanceFromNode(node);
    getNativeFromInternal = component =>
      renderer.ComponentTree.getNodeFromInstance(component);

    // React DOM
  } else if (renderer.Mount.getID && renderer.Mount.getNode) {
    getInternalIDFromNative = (node, findNearestUnfilteredAncestor) => {
      let id = renderer.Mount.getID(node);
      while (node && node.parentNode && !id) {
        node = node.parentNode;
        id = renderer.Mount.getID(node);
      }
      return id;
    };

    getNativeFromInternal = component => {
      try {
        return renderer.Mount.getNode(component._rootNodeID);
      } catch (e) {
        return undefined;
      }
    };
  } else {
    console.warn(
      'Unknown React version (does not have getID), probably an unshimmed React Native'
    );
  }

  let oldMethods;
  let oldRenderComponent;
  let oldRenderRoot;

  // React DOM
  if (renderer.Mount._renderNewRootComponent) {
    oldRenderRoot = decorateResult(
      renderer.Mount,
      '_renderNewRootComponent',
      internalInstance => {
        // TODO Is this right? For all versions?
        const hasOwnerMetadata =
          internalInstance._currentElement != null &&
          internalInstance._currentElement._owner != null;

        const operation = new Uint32Array(5);
        operation[0] = TREE_OPERATION_ADD;
        operation[1] = getID(internalInstance);
        operation[2] = ElementTypeRoot;
        operation[3] = 0; // isProfilingSupported?
        operation[4] = hasOwnerMetadata ? 1 : 0;
        addOperation(operation);

        // If we're mounting a root, we can sync-flush.
        flushPendingEvents(internalInstance);
      }
    );

    // React Native
  } else if (renderer.Mount.renderComponent) {
    oldRenderComponent = decorateResult(
      renderer.Mount,
      'renderComponent',
      internalInstance => {
        // TODO Is this right? For all versions?
        const hasOwnerMetadata =
          internalInstance._currentElement != null &&
          internalInstance._currentElement._owner != null;

        const operation = new Uint32Array(5);
        operation[0] = TREE_OPERATION_ADD;
        operation[1] = getID(internalInstance._reactInternalInstance); // TODO Is this the right internal right?
        operation[2] = ElementTypeRoot;
        operation[3] = 0; // isProfilingSupported?
        operation[4] = hasOwnerMetadata ? 1 : 0;
        addOperation(operation);

        // If we're mounting a root, we can sync-flush.
        flushPendingEvents(internalInstance);
      }
    );
  }

  if (renderer.Component) {
    console.error(
      'You are using a version of React with limited support in this version of the devtools.\n' +
        'Please upgrade to use at least 0.13, or you can downgrade to use the old version of the devtools:\n' +
        'Unstructions here https://github.com/facebook/react-devtools/tree/devtools-next#how-do-i-use-this-for-react--013'
    );

    // 0.11 - 0.12
    // $FlowFixMe renderer.Component is not "possibly undefined"
    oldMethods = decorateMany(renderer.Component.Mixin, {
      mountComponent() {
        rootNodeIDMap.set(this._rootNodeID, this);
        // FIXME DOMComponent calls Component.Mixin, and sets up the
        // `children` *after* that call, meaning we don't have access to the
        // children at this point. Maybe we should find something else to shim
        // (do we have access to DOMComponent here?) so that we don't have to
        // setTimeout.
        setTimeout(() => {
          hook.emit('mount', {
            internalInstance: this,
            data: getData012(this),
            renderer: rid,
          });
        }, 0);
      },
      updateComponent() {
        setTimeout(() => {
          hook.emit('update', {
            internalInstance: this,
            data: getData012(this),
            renderer: rid,
          });
        }, 0);
      },
      unmountComponent() {
        hook.emit('unmount', { internalInstance: this, renderer: rid });
        rootNodeIDMap.delete(this._rootNodeID);
      },
    });
  } else if (renderer.Reconciler) {
    oldMethods = decorateMany(renderer.Reconciler, {
      mountComponent(internalInstance, rootID, transaction, context) {
        const data = getData(internalInstance);
        rootNodeIDMap.set(internalInstance._rootNodeID, internalInstance);
        hook.emit('mount', { internalInstance, data, renderer: rid });
      },
      performUpdateIfNecessary(
        internalInstance,
        nextChild,
        transaction,
        context
      ) {
        hook.emit('update', {
          internalInstance,
          data: getData(internalInstance),
          renderer: rid,
        });
      },
      receiveComponent(internalInstance, nextChild, transaction, context) {
        hook.emit('update', {
          internalInstance,
          data: getData(internalInstance),
          renderer: rid,
        });
      },
      unmountComponent(internalInstance) {
        hook.emit('unmount', { internalInstance, renderer: rid });
        rootNodeIDMap.delete(internalInstance._rootNodeID);
      },
    });
  }

  extras.walkTree = function(
    visit: (component: OpaqueNodeHandle, data: DataType) => void,
    visitRoot: (internalInstance: OpaqueNodeHandle) => void
  ) {
    const onMount = (component, data) => {
      rootNodeIDMap.set(component._rootNodeID, component);
      visit(component, data);
    };
    walkRoots(
      renderer.Mount._instancesByReactRootID ||
        renderer.Mount._instancesByContainerID,
      onMount,
      visitRoot,
      isPre013
    );
  };

  function cleanup() {
    if (oldMethods) {
      if (renderer.Component) {
        restoreMany(renderer.Component.Mixin, oldMethods);
      } else {
        restoreMany(renderer.Reconciler, oldMethods);
      }
    }
    if (oldRenderRoot) {
      renderer.Mount._renderNewRootComponent = oldRenderRoot;
    }
    if (oldRenderComponent) {
      renderer.Mount.renderComponent = oldRenderComponent;
    }
    oldMethods = null;
    oldRenderRoot = null;
    oldRenderComponent = null;
  }

  let pendingOperations: Uint32Array = new Uint32Array(0);

  function addOperation(
    newAction: Uint32Array,
    addToStartOfQueue: boolean = false
  ): void {
    const oldActions = pendingOperations;
    pendingOperations = new Uint32Array(oldActions.length + newAction.length);
    if (addToStartOfQueue) {
      pendingOperations.set(newAction);
      pendingOperations.set(oldActions, newAction.length);
    } else {
      pendingOperations.set(oldActions);
      pendingOperations.set(newAction, oldActions.length);
    }
  }

  // Older React renderers did not have the concept of a commit.
  // The data structure was just ad-hoc mutated in place.
  // So except for the case of the root mounting the first time,
  // there is no event we can observe to signal that a render is finished.
  // However since older renderers were always synchronous,
  // we can use setTimeout to batch operations together.
  // In the case of a cascading update, we might batch multiple "commits"-
  // but that should be okay, since the batching is not strictly necessary.
  const rootIDToTimeoutIDMap: Map<Id, TimeoutID> = new Map();
  function queueFlushPendingEvents(root: Object) {
    const id = getID(root);
    if (!rootIDToTimeoutIDMap.has(id)) {
      const timeoutID = setTimeout(() => {
        rootIDToTimeoutIDMap.delete(id);
        flushPendingEvents(root);
      }, 0);
      rootIDToTimeoutIDMap.set(id, timeoutID);
    }
  }

  function flushPendingEvents(root: Object): void {
    // Identify which renderer this update is coming from.
    // This enables roots to be mapped to renderers,
    // Which in turn enables fiber props, states, and hooks to be inspected.
    const idArray = new Uint32Array(2);
    idArray[0] = rendererID;
    idArray[1] = getID(root);
    addOperation(idArray, true);

    // If we've already connected to the frontend, just pass the operations through.
    hook.emit('operations', pendingOperations);

    pendingOperations = new Uint32Array(0);
  }

  function inspectElement(id: number): InspectedElement | null {
    // TODO
  }

  function logElementToConsole(id: number): void {
    // TODO
  }

  function prepareViewElementSource(id: number): void {
    // TODO
  }

  function selectElement(id: number): void {
    // TODO
  }

  let setInContext: (
    id: number,
    path: Array<string | number>,
    value: any
  ) => void = null;
  let setInProps: (
    id: number,
    path: Array<string | number>,
    value: any
  ) => void = null;
  let setInState: (
    id: number,
    path: Array<string | number>,
    value: any
  ) => void = null;
  if (isPre013) {
    setInProps = (id: number, path: Array<string | number>, value: any) => {
      const instance = idToInternalInstanceMap.get(id);
      if (instance != null) {
        instance.props = copyWithSet(instance.props, path, value);
        instance.forceUpdate();
      }
    };

    setInState = (id: number, path: Array<string | number>, value: any) => {
      const instance = idToInternalInstanceMap.get(id);
      if (instance != null) {
        setIn(instance.state, path, value);
        instance.forceUpdate();
      }
    };

    setInContext = (id: number, path: Array<string | number>, value: any) => {
      const instance = idToInternalInstanceMap.get(id);
      if (instance != null) {
        setIn(instance.context, path, value);
        instance.forceUpdate();
      }
    };
  } else {
    const forceUpdate = instance => {
      if (typeof instance.forceUpdate === 'function') {
        instance.forceUpdate();
      } else if (
        instance.updater != null &&
        typeof instance.updater.enqueueForceUpdate === 'function'
      ) {
        instance.updater.enqueueForceUpdate(this, () => {}, 'forceUpdate');
      }
    };

    setInProps = (id: number, path: Array<string | number>, value: any) => {
      const internalInstance = idToInternalInstanceMap.get(id);
      if (internalInstance != null) {
        const element = internalInstance._currentElement;
        internalInstance._currentElement = {
          ...element,
          props: copyWithSet(element.props, path, value),
        };
        forceUpdate(internalInstance._internalInstance);
      }
    };

    setInState = (id: number, path: Array<string | number>, value: any) => {
      const internalInstance = idToInternalInstanceMap.get(id);
      if (internalInstance != null) {
        setIn(internalInstance.state, path, value);
        internalInstance.forceUpdate();
      }
    };

    setInContext = (id: number, path: Array<string | number>, value: any) => {
      const internalInstance = idToInternalInstanceMap.get(id);
      if (internalInstance != null) {
        setIn(internalInstance.context, path, value);
        forceUpdate(internalInstance);
      }
    };
  }

  function setIn(obj: Object, path: Array<string | number>, value: any) {
    var last = path.pop();
    var parent = path.reduce((obj_, attr) => (obj_ ? obj_[attr] : null), obj);
    if (parent) {
      parent[last] = value;
    }
  }

  return {
    cleanup,
    getInternalIDFromNative,
    getNativeFromInternal,
    inspectElement,
    logElementToConsole,
    prepareViewElementSource,
    renderer,
    selectElement,
    setInContext,
    setInProps,
    setInState,
  };
}

function walkRoots(roots, onMount, onRoot, isPre013) {
  for (let name in roots) {
    walkNode(roots[name], onMount, isPre013);
    onRoot(roots[name]);
  }
}

function walkNode(internalInstance, onMount, isPre013) {
  const data = isPre013
    ? getData012(internalInstance)
    : getData(internalInstance);
  if (data.children && Array.isArray(data.children)) {
    data.children.forEach(child => walkNode(child, onMount, isPre013));
  }
  onMount(internalInstance, data);
}

function decorateResult(obj, attr, fn) {
  const old = obj[attr];
  obj[attr] = function(instance: NodeLike) {
    const res = old.apply(this, arguments);
    fn(res);
    return res;
  };
  return old;
}

function decorate(obj, attr, fn) {
  const old = obj[attr];
  obj[attr] = function(instance: NodeLike) {
    const res = old.apply(this, arguments);
    fn.apply(this, arguments);
    return res;
  };
  return old;
}

function decorateMany(source, fns) {
  const olds = {};
  for (const name in fns) {
    olds[name] = decorate(source, name, fns[name]);
  }
  return olds;
}

function restoreMany(source, olds) {
  for (let name in olds) {
    source[name] = olds[name];
  }
}
