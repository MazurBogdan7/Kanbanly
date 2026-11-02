import { useMemo } from "react";

import { useT } from "@/i18n";
import type { BoardConfig, CardOut, ViewTemplate } from "@/lib/api/types";

import { formatFieldValue } from "./CardFace";
import { groupCards, sortCards } from "./model";

function dimensionLabel(card: CardOut, dimension: NonNullable<BoardConfig["dimensions"]>[number]) {
  return (card.values[dimension.key] ?? [])
    .map((key) => dimension.values?.find((value) => value.key === key)?.name ?? key)
    .join(", ");
}

export function TableView({
  config,
  cards,
  view,
  onOpen,
}: {
  config: BoardConfig;
  cards: CardOut[];
  view: ViewTemplate | undefined;
  onOpen?: (card: CardOut) => void;
}) {
  const { t } = useT();
  const dimensions = config.dimensions ?? [];
  const fields = config.fields ?? [];
  const groupDimension = dimensions.find((item) => item.key === view?.group_by);
  const groups = useMemo(
    () => groupCards(sortCards(cards, view, config), groupDimension),
    [cards, view, config, groupDimension],
  );
  return (
    <div className="kb-table-wrap">
      <table className="kb-table">
        <thead>
          <tr>
            <th scope="col">{t("table.title")}</th>
            <th scope="col">{t("table.status")}</th>
            {dimensions.map((dimension) => (
              <th key={dimension.key} scope="col">
                {dimension.name}
              </th>
            ))}
            {fields.map((field) => (
              <th key={field.key} scope="col">
                {field.name}
              </th>
            ))}
            <th scope="col">{t("table.due")}</th>
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group.key}>
            {groupDimension && (
              <tr className="kb-table-group">
                <th colSpan={dimensions.length + fields.length + 3} scope="colgroup">
                  {group.value?.name ?? t("table.noGroup")} · {group.cards.length}
                </th>
              </tr>
            )}
            {group.cards.map((card) => (
              <tr key={card.id} data-card-id={card.id}>
                <td>
                  <button type="button" className="kb-table-link" onClick={() => onOpen?.(card)}>
                    {card.title}
                  </button>
                </td>
                <td>{config.columns.find((column) => column.key === card.column)?.name}</td>
                {dimensions.map((dimension) => (
                  <td key={dimension.key}>{dimensionLabel(card, dimension)}</td>
                ))}
                {fields.map((field) => (
                  <td key={field.key}>{formatFieldValue(field, card.fields[field.key])}</td>
                ))}
                <td>{card.due_date}</td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
