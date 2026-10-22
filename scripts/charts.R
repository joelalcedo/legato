# Charts for the README, from `legato analyze --since <date> --json`.
# Usage: Rscript scripts/charts.R analyze.json docs/img
# The JSON stays out of the repo (it holds the first words of real prompts); only the PNGs go in.
suppressPackageStartupMessages({library(dplyr); library(tidyr); library(ggplot2); library(jsonlite); library(scales)})
args <- commandArgs(trailingOnly = TRUE)
src <- args[1]; fig <- args[2]
dir.create(fig, showWarnings = FALSE, recursive = TRUE)

# House style.
PAL <- c("#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4")
INK <- "#0b0b0b"; INK2 <- "#52514e"; MUTED <- "#898781"; GRID <- "#e1e0d9"; SURF <- "#fcfcfb"; ZERO <- "#c3c2b7"
theme_bk <- theme_minimal(base_size = 12) +
  theme(plot.background = element_rect(fill = SURF, colour = NA), panel.grid.minor = element_blank(),
        panel.grid.major = element_line(colour = GRID, linewidth = 0.3), axis.text = element_text(colour = MUTED),
        axis.title = element_text(colour = INK2), plot.title = element_text(colour = INK, face = "bold"),
        plot.subtitle = element_text(colour = INK2), legend.position = "bottom", legend.title = element_blank(),
        legend.text = element_text(colour = INK2), plot.title.position = "plot")
WITHOUT <- "#383835"; WITH <- PAL[1]
save2x <- function(p, name, w, h) ggsave(file.path(fig, name), p, width = w, height = h, dpi = 200, bg = SURF)

d <- fromJSON(src, simplifyVector = TRUE)
tot <- d$totals
turns <- as_tibble(d$turns) %>% mutate(saved = baselineUsd - routedUsd, at = as.POSIXct(at / 1000, origin = "1970-01-01", tz = "UTC"))
has <- function(sig, what) vapply(sig, function(s) any(grepl(what, s)), logical(1))

# Each task gets the name a person would give it. Subagents are one task per run.
turns <- turns %>% mutate(
  task = case_when(
    agentType == "Explore" ~ "Explore agent: search the codebase",
    agentType == "general-purpose" ~ "General-purpose agent run",
    agentType != "main" ~ "Other subagent run",
    wanted == "haiku" ~ "Quick task: commit, find a file",
    wanted == "sonnet" & has(signals, "confirmation") ~ "\"Yes, go ahead\"",
    wanted == "sonnet" ~ "Ordinary coding task",
    wanted == "opus" & has(signals, "diagnosis|hard-bug|retry-after-failure") ~ "Find why something fails",
    wanted == "opus" ~ "Design, plan or large change",
    TRUE ~ "Other"))

by_task <- turns %>% group_by(task) %>%
  summarise(n = n(), without = mean(baselineUsd), with = mean(routedUsd), median_without = median(baselineUsd),
            median_with = median(routedUsd), total_saved = sum(saved), saved = mean(saved),
            share_switched = mean(switched), share_held = mean(held), .groups = "drop") %>%
  filter(n >= 10, task != "Other subagent run") %>% arrange(total_saved)
shown <- sum(by_task$n); left_out <- nrow(turns) - shown
by_task$task <- factor(by_task$task, levels = by_task$task)
print(as.data.frame(by_task %>% mutate(across(where(is.numeric), ~ round(.x, 3)))), row.names = FALSE)

saved_total <- tot$baselineUsd - tot$routedUsd
pct <- saved_total / tot$baselineUsd * 100
days <- as.numeric(difftime(as.POSIXct(tot$end / 1000, origin = "1970-01-01"), as.POSIXct(tot$start / 1000, origin = "1970-01-01"), units = "days"))
cat(sprintf("\nTotals: without $%.0f, with $%.0f, saved $%.0f (%.1f%%) over %.0f days; %d sessions, %d subagent runs, %d requests, %d tasks\n",
            tot$baselineUsd, tot$routedUsd, saved_total, pct, days, tot$conversations, tot$subagents, tot$requests, nrow(turns)))
day <- function(x, year = FALSE) paste(as.integer(format(x, "%d")), format(x, if (year) "%b %Y" else "%b"))
window <- sprintf("%s to %s", day(min(turns$at)), day(max(turns$at), TRUE))

# Chart 1: what a task costs, with and without Legato.
lab <- by_task %>% mutate(txt = sprintf("%s %s%s per task, about %s over %d tasks", if_else(saved >= 0, "saves", "costs"),
                                        dollar(abs(saved), accuracy = 0.01), if_else(saved >= 0, "", " more"),
                                        dollar(abs(total_saved), accuracy = 1), n),
                          x = pmax(without, with))
long <- by_task %>% pivot_longer(c(without, with), names_to = "which", values_to = "usd") %>%
  mutate(which = factor(if_else(which == "without", "Claude Code alone", "With Legato"), levels = c("Claude Code alone", "With Legato")))
top <- by_task %>% slice_max(saved, n = 1)
p1 <- ggplot(by_task) +
  geom_segment(aes(x = with, xend = without, y = task, yend = task), colour = GRID, linewidth = 2.2) +
  geom_point(data = long, aes(usd, task, colour = which), size = 3.4) +
  geom_text(data = lab, aes(x = x, y = task, label = txt), hjust = 0, nudge_x = 0.12, size = 3.2, colour = INK2) +
  scale_colour_manual(values = c("Claude Code alone" = WITHOUT, "With Legato" = WITH)) +
  scale_x_continuous(labels = dollar_format(accuracy = 1), breaks = seq(0, 10, 2), expand = expansion(mult = c(0.02, 0.75))) +
  theme_bk + theme(panel.grid.major.y = element_blank(), axis.text.y = element_text(colour = INK, size = 11)) +
  labs(x = "Mean cost of one task, at list prices", y = NULL,
       title = "Most of the saving is in subagent runs and ordinary coding tasks; hard tasks pay a little to bring Opus back",
       subtitle = sprintf("Mean cost of a task with and without Legato, at API list prices. A task is one request from you and everything Claude Code does to finish it.\n%s of the %s tasks in one month of one developer's Claude Code history (%s), cache rebuilds included.\nThe %d left out are in kinds too small to show.",
                          format(shown, big.mark = ","), format(nrow(turns), big.mark = ","), window, left_out))
save2x(p1, "cost-per-task.png", 13, 7)

# Chart 2: the bill over the month, with and without.
series <- as_tibble(d$series) %>% mutate(at = as.POSIXct(t / 1000, origin = "1970-01-01", tz = "UTC"))
series <- series[unique(c(seq(1, nrow(series), by = max(1, nrow(series) %/% 4000)), nrow(series))), ]
cum <- series %>% transmute(at, `Claude Code alone` = baseline, `With Legato` = routed) %>%
  pivot_longer(-at, names_to = "which", values_to = "usd") %>%
  mutate(which = factor(which, levels = c("Claude Code alone", "With Legato")))
ends <- cum %>% group_by(which) %>% filter(at == max(at)) %>% ungroup() %>%
  mutate(label = sprintf("%s  %s", which, dollar(usd, accuracy = 1)))
XL <- c(min(cum$at), max(cum$at) + as.difftime(7.5, units = "days"))
p2 <- ggplot(cum, aes(at, usd, colour = which)) +
  geom_hline(yintercept = 0, colour = ZERO) +
  geom_line(linewidth = 0.8) +
  ggrepel::geom_text_repel(data = ends, aes(label = label), size = 3.4, direction = "y", hjust = 0, nudge_x = 40000,
                           segment.colour = GRID, show.legend = FALSE, min.segment.length = 0) +
  scale_colour_manual(values = c("Claude Code alone" = WITHOUT, "With Legato" = WITH)) +
  scale_x_datetime(limits = XL, labels = function(x) day(x), expand = expansion(mult = c(0.01, 0))) +
  scale_y_continuous(labels = dollar_format(accuracy = 1)) +
  theme_bk + theme(legend.position = "none") +
  labs(x = NULL, y = "Cumulative cost, at list prices",
       title = sprintf("Over the month Legato would have cut usage by %s, %.0f%% at API list prices", dollar(saved_total, accuracy = 1), pct),
       subtitle = sprintf("Every request in %d sessions and %d subagent runs replayed through Legato's decision engine, %s.\nThe gap is the saving after paying for every cache rebuild a change of model caused. Most of the usage arrived on a few heavy days.",
                          tot$conversations, tot$subagents, window))
save2x(p2, "bill-over-the-month.png", 12, 6)
cat("wrote", file.path(fig, c("cost-per-task.png", "bill-over-the-month.png")), "\n")
