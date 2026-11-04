// Picks the currency flight prices are shown in, on the card and in Settings → Flights:
// a button that says what prices are in, opening a short list you can search. There are
// over 160 currencies, so it's built to be typed into rather than scrolled through.

import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { Popover } from "radix-ui";
import { useState } from "react";

import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { currencyName, loadRates, setPickedCurrency, useCurrencyOptions, usePickedCurrency } from "@/lib/currency";

const SELLERS = "sellers-currency";

function Option({ code, picked, onPick }: { code: string; picked: boolean; onPick: (code: string) => void }) {
  const name = currencyName(code);
  return (
    <CommandItem value={code} keywords={[name]} onSelect={() => onPick(code)}>
      <span className="w-10 shrink-0 font-medium tabular-nums">{code}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{name}</span>
      {picked && <CheckIcon className="size-4 shrink-0 text-brand" aria-hidden />}
    </CommandItem>
  );
}

/** `quoted` is what the seller's prices are in, when there's a card to know from. */
export function CurrencySelect({ quoted }: { quoted?: string }) {
  const [open, setOpen] = useState(false);
  const picked = usePickedCurrency();
  const { common, others } = useCurrencyOptions();
  // Until the rates load, a less common pick isn't in the list but still has to show.
  const shownFirst = picked && !common.includes(picked) && !others.includes(picked) ? [...common, picked] : common;
  const pick = (code: string | null) => {
    setPickedCurrency(code);
    setOpen(false);
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) loadRates();
      }}
    >
      <Popover.Trigger className="flex h-8 items-center gap-1.5 rounded-xl border border-border px-3 text-xs transition-colors outline-none hover:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/50">
        <span className="text-muted-foreground">Prices in</span>
        <span className="font-medium tabular-nums">{picked ?? quoted ?? "seller's currency"}</span>
        <ChevronDownIcon className="size-3.5 text-muted-foreground" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 w-72 max-w-(--radix-popover-content-available-width) origin-(--radix-popover-content-transform-origin) overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-md duration-150 outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <Command defaultValue={picked ?? SELLERS} className="bg-transparent">
            <CommandInput placeholder="Search currencies" />
            <CommandList className="max-h-64">
              <CommandEmpty>No currency by that name.</CommandEmpty>
              <CommandGroup>
                <CommandItem value={SELLERS} keywords={["seller", "original", "quoted"]} onSelect={() => pick(null)}>
                  <span className="min-w-0 flex-1 truncate">Seller's currency{quoted ? ` (${quoted})` : ""}</span>
                  {!picked && <CheckIcon className="size-4 shrink-0 text-brand" aria-hidden />}
                </CommandItem>
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Common">
                {shownFirst.map((code) => (
                  <Option key={code} code={code} picked={code === picked} onPick={pick} />
                ))}
              </CommandGroup>
              {others.length > 0 && (
                <CommandGroup heading="All currencies">
                  {others.map((code) => (
                    <Option key={code} code={code} picked={code === picked} onPick={pick} />
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
