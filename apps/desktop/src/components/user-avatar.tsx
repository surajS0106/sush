// The account's picture: an uploaded photo, a built-in sushi avatar, or the
// name's initial on the accent color.

import { builtinAvatar, spriteRects, type AvatarDef } from "@/lib/avatars";
import { cn } from "@/lib/utils";

interface UserAvatarProps {
  image?: string | null;
  name?: string | null;
  email?: string | null;
  className?: string;
}

export function UserAvatar({ image, name, email, className }: UserAvatarProps) {
  const avatar = builtinAvatar(image);
  const base = cn("relative flex shrink-0 items-center justify-center overflow-hidden rounded-full", className);
  if (avatar) return <AvatarSprite avatar={avatar} className={base} />;
  if (image) return <img src={image} alt="" draggable={false} className={cn(base, "object-cover")} />;
  return (
    <span className={cn(base, "bg-brand font-medium text-brand-foreground")} aria-hidden>
      {(name?.trim() || email || "?").charAt(0).toUpperCase()}
    </span>
  );
}

export function AvatarSprite({ avatar, className }: { avatar: AvatarDef; className?: string }) {
  // Two pixels of padding around the 12×12 sprite.
  return (
    <svg viewBox="-2 -2 16 16" shapeRendering="crispEdges" className={className} style={{ background: avatar.background }} aria-hidden>
      {spriteRects(avatar).map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />
      ))}
    </svg>
  );
}
