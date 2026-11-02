/** Чек-листы, комментарии, ссылки и история карточки. */
import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button, Input, Section, Textarea } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { useT } from "@/i18n";
import { api } from "@/lib/api/client";
import type { CardDetail, CardEventOut } from "@/lib/api/types";
import { SafeMarkdown } from "@/lib/markdown";

import { keys, useCardActivity } from "../boards/api";

function eventText(event: CardEventOut, t: ReturnType<typeof useT>["t"]): string {
  switch (event.action) {
    case "moved":
      return t("card.event.moved", {
        source: String(event.data.source),
        target: String(event.data.target),
      });
    case "created":
    case "updated":
    case "deleted":
    case "restored":
    case "commented":
      return t(`card.event.${event.action}`);
    default:
      return event.action;
  }
}

function InlineAdd({ label, onAdd }: { label: string; onAdd: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form
      className="flex gap-2"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (text.trim()) onAdd(text.trim());
        setText("");
      }}
    >
      <Input
        aria-label={label}
        placeholder={label}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <Button type="submit">+</Button>
    </form>
  );
}

export function CardExtras({
  boardId,
  card,
  readOnly,
}: {
  boardId: string;
  card: CardDetail;
  readOnly?: boolean;
}) {
  const { t, locale } = useT();
  const queryClient = useQueryClient();
  const activity = useCardActivity(card.id);
  const [comment, setComment] = useState("");
  const [link, setLink] = useState({ name: "", url: "" });

  const run = (request: Promise<unknown>) => {
    request
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: keys.card(card.id) });
        void queryClient.invalidateQueries({ queryKey: keys.activity(card.id) });
        void queryClient.invalidateQueries({ queryKey: keys.cards(boardId) });
      })
      .catch(toast.error);
  };

  return (
    <div className="grid gap-5 border-t border-line pt-4">
      <Section title={t("card.checklists")}>
        {card.checklists.map((checklist) => (
          <div key={checklist.id} className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">{checklist.title}</h3>
              {!readOnly && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`${t("common.delete")}: ${checklist.title}`}
                  onClick={() => run(api.delete(`/checklists/${checklist.id}`))}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              )}
            </div>
            {checklist.items.map((item) => (
              <label key={item.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={item.done}
                  disabled={readOnly}
                  onChange={(event) =>
                    run(api.patch(`/checklist-items/${item.id}`, { done: event.target.checked }))
                  }
                />
                <span className={item.done ? "text-ink-soft line-through" : ""}>{item.text}</span>
              </label>
            ))}
            {!readOnly && (
              <InlineAdd
                label={t("card.addItem")}
                onAdd={(text) => run(api.post(`/checklists/${checklist.id}/items`, { text }))}
              />
            )}
          </div>
        ))}
        {!readOnly && (
          <InlineAdd
            label={t("card.addChecklist")}
            onAdd={(title) => run(api.post(`/cards/${card.id}/checklists`, { title }))}
          />
        )}
      </Section>

      <Section title={t("card.attachments")}>
        {card.attachments.map((attachment) => (
          <div key={attachment.id} className="flex items-center justify-between gap-2 text-sm">
            <a
              href={attachment.url}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate text-brand underline"
            >
              {attachment.name}
            </a>
            {!readOnly && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`${t("common.delete")}: ${attachment.name}`}
                onClick={() => run(api.delete(`/attachments/${attachment.id}`))}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
            )}
          </div>
        ))}
        {!readOnly && (
          <form
            className="flex gap-2"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              run(api.post(`/cards/${card.id}/attachments`, link));
              setLink({ name: "", url: "" });
            }}
          >
            <Input
              aria-label={t("card.attachmentName")}
              placeholder={t("card.attachmentName")}
              required
              value={link.name}
              onChange={(event) => setLink({ ...link, name: event.target.value })}
            />
            <Input
              aria-label={t("card.attachmentUrl")}
              placeholder={t("card.attachmentUrl")}
              type="url"
              required
              value={link.url}
              onChange={(event) => setLink({ ...link, url: event.target.value })}
            />
            <Button type="submit">+</Button>
          </form>
        )}
      </Section>

      <Section title={t("card.comments")}>
        {card.comments.map((item) => (
          <div key={item.id} className="grid gap-1 rounded-md bg-raised p-2">
            <p className="text-xs text-ink-soft">
              {item.author_name} · {new Date(item.created_at).toLocaleString(locale)}
            </p>
            <SafeMarkdown source={item.body} className="prose-card text-sm" />
          </div>
        ))}
        {!readOnly && (
          <form
            className="grid gap-2"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              if (!comment.trim()) return;
              run(api.post(`/cards/${card.id}/comments`, { body: comment }));
              setComment("");
            }}
          >
            <Textarea
              aria-label={t("card.addComment")}
              placeholder={t("card.addComment")}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
            <Button type="submit" className="justify-self-end">
              {t("card.send")}
            </Button>
          </form>
        )}
      </Section>

      <Section title={t("card.history")}>
        <ol className="grid gap-1 text-xs text-ink-soft">
          {activity.data?.map((event) => (
            <li key={event.id}>
              {event.actor_name} {eventText(event, t)} ·{" "}
              {new Date(event.created_at).toLocaleString(locale)}
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}
