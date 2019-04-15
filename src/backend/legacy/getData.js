// @flow

import {
  ElementTypeClass,
  ElementTypeOtherOrUnknown,
} from 'src/devtools/types';
import { getDisplayName } from 'src/utils';

import type { InternalInstance } from './renderer';
import type { FiberData } from '../types';

export default function getData(internalInstance: InternalInstance): FiberData {
  let displayName = null;
  let key = null;
  let type = ElementTypeOtherOrUnknown;

  // != used deliberately here to catch undefined and null
  if (internalInstance._currentElement != null) {
    if (internalInstance._currentElement.key) {
      key = String(internalInstance._currentElement.key);
    }

    const elementType = internalInstance._currentElement.type;
    if (typeof elementType === 'string') {
      // ...
    } else if (typeof elementType === 'function') {
      // TODO Can we differentiate between function and class component types?
      type = ElementTypeClass;
      displayName = getDisplayName(elementType);
    } else if (typeof internalInstance._stringText === 'string') {
      // ...
    } else {
      // TODO What kind of case does this cover?
      console.log('what is this type?');
      displayName = getDisplayName(elementType);
    }
  }

  return {
    displayName,
    key,
    type,
  };
}
