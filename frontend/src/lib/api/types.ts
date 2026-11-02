/** Псевдонимы над типами, сгенерированными из OpenAPI. Единственный источник — Pydantic. */
import type { components } from "./schema.gen";

type S = components["schemas"];

export type UserOut = S["UserOut"];
export type SessionOut = S["SessionOut"];
export type ProjectOut = S["ProjectOut"];
export type BoardSummary = S["BoardSummary"];
export type BoardOut = S["BoardOut"];
export type CardOut = S["CardOut"];
export type CardDetail = S["CardDetail"];
export type CardEventOut = S["CardEventOut"];
export type ChecklistOut = S["ChecklistOut"];
export type TemplateOut = S["TemplateOut"];
export type TemplatePreview = S["TemplatePreview"];
export type PresetOut = S["PresetOut"];
export type SearchHit = S["SearchHit"];
export type TrashItem = S["TrashItem"];
export type BackupPreview = S["BackupPreview"];
export type BackupHistory = S["BackupHistory"];
export type BackupImportResult = S["BackupImportResult"];
export type RecoveryCodesOut = S["RecoveryCodesOut"];
export type TotpSetupOut = S["TotpSetupOut"];

export type BoardConfig = S["BoardConfig"];
export type BoardTemplate = S["BoardTemplate"];
export type Theme = S["Theme"];
export type Typography = S["Typography"];
export type TypeRole = S["TypeRole"];
export type Layout = S["Layout"];
export type CardLayout = S["CardLayout"];
export type ColumnLayout = S["ColumnLayout"];
export type ColumnTemplate = S["ColumnTemplate"];
export type DimensionTemplate = S["DimensionTemplate"];
export type DimensionValueTemplate = S["DimensionValueTemplate"];
export type FieldTemplate = S["FieldTemplate"];
export type ViewTemplate = S["ViewTemplate"];
export type BadgeConfig = S["BadgeConfig"];
export type SampleCard = S["SampleCard"];

export type Widget = NonNullable<NonNullable<Layout["header"]>["widgets"]>[number];
export type Rule = NonNullable<BoardConfig["rules"]>[number];
export type Background = NonNullable<Theme["board_background"]>;

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export type DimensionRole = NonNullable<DimensionTemplate["roles"]>[number];
export type ColumnKind = NonNullable<ColumnTemplate["kind"]>;
export type FaceSlot = NonNullable<CardLayout["face"]>[number];
export type FieldType = FieldTemplate["type"];
