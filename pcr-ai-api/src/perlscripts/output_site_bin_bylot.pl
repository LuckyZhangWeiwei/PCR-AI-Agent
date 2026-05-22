#!/usr/local/bin/perl
$ENV{'PATH'} = '/bin:/usr/bin:/usr/local/bin:/usr/ucb:/bin';
use lib "/exec/apps/bin/lib/perl5";
use strict;
use warnings;
use Data::Dumper;
require Referencedie;
use INFAnalysis;

# 从 INF wafer map 统计：每一片 wafer 的每个测试 pass（PASS_TYPE=TEST，可多个 PASS_ID），
# 各 bin 测试结果由 probe card 上哪个 DUT（iTestSiteLast）测得、各 DUT 上 die 颗数。
# 用法: perl output_site_bin_bylot.pl <inf_path> <pass_id> [pass_id ...]
#       pass 可用逗号分隔: perl ... inf 1,3,5
#       JSON: perl output_site_bin_bylot.pl --json <inf_path> <pass_id> ...
if (@ARGV >= 2) {
    my $json_mode = (@ARGV && $ARGV[0] eq '--json') ? 1 : 0;
    shift @ARGV if $json_mode;
    my $inf_path   = untaint($ARGV[0]);
    my @pass_ids   = parse_pass_list(@ARGV[1 .. $#ARGV]);
    my $summary    = summarize_bin_by_dut($inf_path, \@pass_ids);
    if ($json_mode) {
        print_bin_dut_summary_json($summary);
    }
    else {
        print_bin_dut_summary($summary);
    }
}
else {
    print STDERR "Usage: $0 [--json] <inf_path> <pass_id> [pass_id ...]\n";
    exit 1;
}

# 输入 INF 路径与 pass 列表（标量/数组引用/多个标量均可），仅处理 PASS_TYPE=TEST 且 PASS_ID 匹配的 SmWaferPass
# 返回: { pass_id => { bin_code => { dut => die_count } } }
sub summarize_bin_by_dut {
    my $inf_path = shift;
    die "inf_path required\n" unless defined $inf_path && $inf_path ne '';

    my @pass_args = (@_ == 1 && ref($_[0]) eq 'ARRAY') ? @{ $_[0] } : @_;
    my %pass_ok = map { $_ => 1 } parse_pass_list(@pass_args);
    die "pass_filter required\n" unless %pass_ok;

    $inf_path = untaint($inf_path);

    my $inf_obj = INFAnalysis->new();
    $inf_obj->LoadINF($inf_path);

    my @SmWaferPass = $inf_obj->block('SmWaferFlow')->blocks('SmWaferPass');
    my %by_pass;

    foreach my $SmWaferPass (@SmWaferPass) {
        my $pass = $SmWaferPass->key('PASS_ID');
        next unless exists $pass_ok{$pass};

        my $pass_type = $SmWaferPass->key('PASS_TYPE');
        next unless defined $pass_type && $pass_type eq 'TEST';

        my @rowdata_pass_bin;
        my @rowdata_pass_site;
        my @MatrixData_bin;
        my @MatrixData_site;

        my $layer_bin = ($SmWaferPass->block('MdMapResult')->getLayers('iBinCodeLast'))[0];
        next unless defined $layer_bin;

        @rowdata_pass_bin = $layer_bin->getRowData('NlLayer');
        my $Rowmin = $layer_bin->key('iRowMin');
        my $Colmin = $layer_bin->key('iColMin');
        @MatrixData_bin = convert(\@rowdata_pass_bin);

        my $xlength = scalar @MatrixData_bin;
        my $ylength = scalar @{ $MatrixData_bin[0] };

        my $layer_site = ($SmWaferPass->block('MdMapResult')->getLayers('iTestSiteLast'))[0];
        if (defined $layer_site && $layer_site ne '') {
            @rowdata_pass_site = $layer_site->getRowData('NlLayer');
            @MatrixData_site   = convert(\@rowdata_pass_site);
        }

        for (my $j = 0; $j < $ylength; $j++) {
            for (my $i = 0; $i < $xlength; $i++) {
                next unless isTestDie($MatrixData_bin[$i][$j]);

                my $bin = hex($MatrixData_bin[$i][$j]);
                my $dut;
                if (@MatrixData_site) {
                    $dut = hex($MatrixData_site[$i][$j]);
                }
                else {
                    $dut = 'single';
                }

                $by_pass{$pass}{$bin}{$dut}++;
            }
        }
    }

    return \%by_pass;
}

sub parse_pass_list {
    my @ids;
    for my $arg (@_) {
        for my $part (split /,/, $arg) {
            $part =~ s/^\s+|\s+$//g;
            next if $part eq '';
            push @ids, int($part);
        }
    }
    return @ids;
}

sub bin_label {
    my ($bin_code) = @_;
    return 'bin' . (0 + $bin_code);
}

# REST API --json：{ passes: [ { passId (wafer pass), bins: [ { bin: "bin55" (测试结果 bin), duts: [ { dut (probe card DUT#), dieCount } ] } ] } ] }
sub print_bin_dut_summary_json {
    my ($by_pass) = @_;
    require JSON::PP;
    my $enc = JSON::PP->new->canonical(1);

    my @passes;
    for my $pass_id (sort { $a <=> $b } keys %$by_pass) {
        my $summary = $by_pass->{$pass_id};
        my @bins;

        for my $bin_code (sort { $a <=> $b } keys %$summary) {
            my $duts = $summary->{$bin_code};
            my @dut_list = sort {
                $a eq 'single' ? 1
                : $b eq 'single' ? -1
                : $a <=> $b
            } keys %$duts;

            my @dut_entries;
            for my $dut (@dut_list) {
                my $dut_out = ($dut eq 'single') ? 'single' : (0 + $dut);
                push @dut_entries, { dut => $dut_out, dieCount => $duts->{$dut} };
            }
            push @bins, {
                bin  => bin_label($bin_code),
                duts => \@dut_entries,
            };
        }

        push @passes, { passId => 0 + $pass_id, bins => \@bins };
    }

    print $enc->encode({ passes => \@passes });
}

sub print_bin_dut_summary {
    my ($by_pass) = @_;
    for my $pass_id (sort { $a <=> $b } keys %$by_pass) {
        my $summary = $by_pass->{$pass_id};
        print "PASS_ID: $pass_id\n";
        print "bin\tdut(s)\tdie_count\n";

        for my $bin_code (sort { $a <=> $b } keys %$summary) {
            my $duts = $summary->{$bin_code};
            my @dut_list = sort {
                $a eq 'single' ? 1
                : $b eq 'single' ? -1
                : $a <=> $b
            } keys %$duts;

            my @parts;
            for my $dut (@dut_list) {
                push @parts, "$dut($duts->{$dut})";
            }
            print bin_label($bin_code), "\t", join(',', @dut_list), "\t", join(' ', @parts), "\n";
        }
        print "\n";
    }
}

sub convert {
    my $before = shift;
    my @after;
    my @TempRowData = @$before;
    return @after unless @TempRowData;

    my $ColumnLength = scalar(split(/\s/, $TempRowData[0]));
    my $RowLength    = scalar @TempRowData;
    for (my $j = 0; $j < $RowLength; $j++) {
        my @row = split(/\s/, $TempRowData[$j]);
        for (my $i = 0; $i < $ColumnLength; $i++) {
            $after[$i][$j] = $row[$i];
        }
    }
    return @after;
}

sub untaint { $_[0] =~ /^(.+)$/; $1 }
