// React wrapper for <project-m-visualizer>.
//
// React 18 and earlier set unknown JSX props as attributes but do not subscribe
// `onFoo` props to CustomEvents, and they stringify objects as "[object Object]".
// This component does both correctly, and gives the element a real ref.
//
// Written with createElement rather than JSX so the package needs no JSX build
// step and no React version pinned at build time.

import { createElement, forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { ELEMENT_TAG } from '../staging/projectm-element-attributes.js';
import '../staging/projectm-element.js';
import {
    applyProjectMAttributes,
    bindProjectMEvents,
    splitPassthroughProps,
} from './bindings.js';

/**
 * The element's attributes and events as props: @projectm/types/element, the
 * one description of `<project-m-visualizer>` html/ and this package share.
 *
 * @typedef {import('@projectm/types/element').ProjectMVisualizerProps} ProjectMVisualizerProps
 */

export const ProjectMVisualizer = forwardRef(
    /**
     * @param {ProjectMVisualizerProps & Record<string, any>} props
     * @param {any} ref
     */
    function ProjectMVisualizer(props, ref) {
        const elementRef = useRef(/** @type {any} */ (null));
        useImperativeHandle(ref, () => elementRef.current, []);

        // Attributes are written in an effect, not handed to createElement, so
        // that objects (external-pcm-origins) and booleans reach the element in
        // the form it parses instead of React's stringification.
        useEffect(() => {
            if (elementRef.current) applyProjectMAttributes(elementRef.current, props);
        });

        useEffect(() => {
            if (!elementRef.current) return undefined;
            return bindProjectMEvents(elementRef.current, props);
        }, [
            props.onReady,
            props.onError,
            props.onPresetChanged,
            props.onFps,
            props.onAudioSource,
        ]);

        return createElement(ELEMENT_TAG, { ...splitPassthroughProps(props), ref: elementRef });
    },
);

export default ProjectMVisualizer;
