import { Container, CtaLink } from "@/components/storefront/ui";

/** 404 inside the storefront shell (the layout already provides the page's <main>). */
export default function StorefrontNotFound() {
  return (
    <Container className="grid max-w-md justify-items-center gap-3 py-20 text-center">
      <h1 className="text-2xl font-extrabold">Page not found</h1>
      <p className="text-muted-foreground">The page you are looking for does not exist.</p>
      <CtaLink href="/rentals" variant="secondary">
        Browse rentals
      </CtaLink>
    </Container>
  );
}
