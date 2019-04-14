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

  // TODO The below getNativeFromInternal and getInternalIDFromNative methods are probably broken.
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

  let oldReconcilerMethods = null;
  let oldRenderComponent = null;
  let oldRenderRoot = null;

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

  if (renderer.Reconciler) {
    oldReconcilerMethods = decorateMany(renderer.Reconciler, {
      mountComponent(internalInstance, rootID, transaction, context) {
        const id = getID(internalInstance);
        const data = getData(internalInstance);

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
        const id = getID(internalInstance);

        hook.emit('unmount', { internalInstance, renderer: rid });

        idToInternalInstanceMap.delete(id);
        internalInstance.delete(internalInstance);
      },
    });
  }

  function cleanup() {
    if (oldReconcilerMethods !== null) {
      if (renderer.Component) {
        restoreMany(renderer.Component.Mixin, oldReconcilerMethods);
      } else {
        restoreMany(renderer.Reconciler, oldReconcilerMethods);
      }
    }
    if (oldRenderRoot !== null) {
      renderer.Mount._renderNewRootComponent = oldRenderRoot;
    }
    if (oldRenderComponent !== null) {
      renderer.Mount.renderComponent = oldRenderComponent;
    }
    oldReconcilerMethods = null;
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

  function flushInitialOperations() {
    const onMount = (component, data) => {
      const id = getID(component);
      rootNodeIDMap.set(component._rootNodeID, component);
      visit(component, data);
    };

    const walkRoots = (roots, onMount, onRoot) => {
      for (let name in roots) {
        walkNode(roots[name], onMount);
        onRoot(roots[name]);
      }
    };

    const walkNode = (internalInstance, onMount) => {
      const data = getData(internalInstance);
      if (data.children && Array.isArray(data.children)) {
        data.children.forEach(child => walkNode(child, onMount));
      }
      onMount(internalInstance, data);
    };

    walkRoots(
      renderer.Mount._instancesByReactRootID ||
        renderer.Mount._instancesByContainerID,
      onMount,
      visitRoot
    );
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

  function getData(internalInstance: Object): FiberData {
    let displayName = null;
    let key = null;
    let type = ElementTypeOtherOrUnknown;

    // TODO

    return {
      displayName,
      key,
      type,
    };
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

  function forceUpdate(instance) {
    if (typeof instance.forceUpdate === 'function') {
      instance.forceUpdate();
    } else if (
      instance.updater != null &&
      typeof instance.updater.enqueueForceUpdate === 'function'
    ) {
      instance.updater.enqueueForceUpdate(this, () => {}, 'forceUpdate');
    }
  }

  function setInProps(id: number, path: Array<string | number>, value: any) {
    const internalInstance = idToInternalInstanceMap.get(id);
    if (internalInstance != null) {
      const element = internalInstance._currentElement;
      internalInstance._currentElement = {
        ...element,
        props: copyWithSet(element.props, path, value),
      };
      forceUpdate(internalInstance._internalInstance);
    }
  }

  function setInState(id: number, path: Array<string | number>, value: any) {
    const internalInstance = idToInternalInstanceMap.get(id);
    if (internalInstance != null) {
      setIn(internalInstance.state, path, value);
      internalInstance.forceUpdate();
    }
  }

  function setInContext(id: number, path: Array<string | number>, value: any) {
    const internalInstance = idToInternalInstanceMap.get(id);
    if (internalInstance != null) {
      setIn(internalInstance.context, path, value);
      forceUpdate(internalInstance);
    }
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
    flushInitialOperations,
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
