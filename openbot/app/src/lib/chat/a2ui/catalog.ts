import { Catalog } from "@a2ui/web_core/v0_9";
import { BASIC_FUNCTIONS } from "@a2ui/web_core/v0_9/basic_catalog";
import {
  Button,
  CheckBox,
  ChoicePicker,
  DateTimeInput,
  Slider,
  TextField,
} from "./components/inputs";
import { Card, Column, Divider, List, Row } from "./components/layout";
import { AudioPlayer, Icon, Image, Video } from "./components/media";
import { Modal, Tabs } from "./components/overlays";
import { Text } from "./components/text";
import type { ReactComponentImplementation } from "./types";

/**
 * The id of the A2UI v0.9 basic catalog, spelled exactly as the specification and as the runtime's
 * A2UI middleware spell it: every surface the server creates is stamped with this id, and a
 * `createSurface` for an id no catalog answers to is a hard error rather than a blank card.
 */
export const BASIC_CATALOG_ID =
  "https://a2ui.org/specification/v0_9/basic_catalog.json";

/**
 * The basic catalog, drawn by this repository instead of by the CopilotKit A2UI renderer package.
 *
 * Same component names and the same prop schemas as `@a2ui/web_core`'s `BASIC_COMPONENTS` — the
 * schemas are what tell the binder which props are data bindings, which are actions and which are
 * children, so reusing them is what keeps this renderer wire-compatible with the spec rather than
 * merely similar. The functions (validation, formatting, `openUrl`) come straight from web_core.
 */
export const basicCatalog = new Catalog<ReactComponentImplementation>(
  BASIC_CATALOG_ID,
  [
    Text,
    Image,
    Icon,
    Video,
    AudioPlayer,
    Row,
    Column,
    List,
    Card,
    Tabs,
    Modal,
    Divider,
    Button,
    TextField,
    CheckBox,
    ChoicePicker,
    Slider,
    DateTimeInput,
  ],
  BASIC_FUNCTIONS,
);
