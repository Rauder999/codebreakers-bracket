#!/usr/bin/perl
# Rewrite every non-ASCII character in the bot's JS sources as a \uXXXX escape.
#
# The handoff is explicit that these files have been corrupted before by
# transfer pipes that mangle raw UTF-8, so the convention is that the source on
# disk is pure ASCII and all emoji / dashes live as escapes. Doing that by hand
# is how the mangling creeps back in, so run this instead:
#
#     perl tools/ascii-guard.pl            # rewrite in place
#     perl tools/ascii-guard.pl --check    # exit 1 if anything is non-ASCII
#
# Astral-plane characters (emoji) become surrogate pairs, which is what
# JavaScript string escapes need.
#
# There is a python twin of this script for hosts without perl; keep both in
# step if you change the rules.
use strict;
use warnings;
use File::Basename qw(dirname);
use File::Spec;

my $root = File::Spec->catdir(dirname(File::Spec->rel2abs($0)), File::Spec->updir());
my @patterns = qw(*.js stats/*.js web/*.js integration/*.js public/*.js);
my $check = grep { $_ eq '--check' } @ARGV;

sub escape {
    my ($text) = @_;
    my $out = '';
    for my $ch (split //, $text) {
        my $cp = ord($ch);
        if ($cp < 128) { $out .= $ch; next; }
        if ($cp > 0xFFFF) {
            my $v = $cp - 0x10000;
            $out .= sprintf('\u%04X\u%04X', 0xD800 + ($v >> 10), 0xDC00 + ($v & 0x3FF));
        } else {
            $out .= sprintf('\u%04X', $cp);
        }
    }
    return $out;
}

my (@bad, @changed);
for my $pattern (@patterns) {
    for my $path (sort glob(File::Spec->catfile($root, $pattern))) {
        open(my $in, '<:encoding(UTF-8)', $path) or die "open $path: $!";
        local $/;
        my $raw = <$in>;
        close $in;
        next unless defined $raw;
        my $esc = escape($raw);
        next if $esc eq $raw;
        my $rel = $path;
        $rel =~ s/\Q$root\E[\\\/]*//;
        if ($check) {
            push @bad, $rel;
        } else {
            open(my $out, '>:raw', $path) or die "write $path: $!";
            print $out $esc;
            close $out;
            push @changed, $rel;
        }
    }
}

if ($check) {
    print "non-ASCII: $_\n" for @bad;
    printf "%d file(s) with non-ASCII\n", scalar @bad;
    exit(@bad ? 1 : 0);
}
print "escaped: $_\n" for @changed;
printf "%d file(s) rewritten\n", scalar @changed;
exit 0;
